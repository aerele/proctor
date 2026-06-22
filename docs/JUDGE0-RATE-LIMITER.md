# Judge0 distributed rate limiter — design + scale ceiling

**Status:** shipped in v1.1 (G3, audit #3). Code: `backend/src/judge0Limiter.mjs`
(the Firestore-backed sharded gate) + `backend/src/lib/tokenBucket.mjs` (pure
refill/consume math). Config: `JUDGE0_LIMITER_*` in `backend/src/config.mjs`.

## Why it exists (the #132 root cause)

proctor-api runs on Cloud Run with `--max-instances 20 --concurrency 100`. The
per-instance exec queue (`execQueue.mjs`) bounds Judge0 submit concurrency **per
instance** — but with up to 20 instances, the effective global submit rate is up
to 20× the per-instance lane cap. That is the structural cause of the live
Judge0 **HTTP 429** storm (#132): no single instance can see, let alone cap, the
fleet-wide submit rate.

A cross-instance cap needs **shared state**. We use a **Firestore-backed sharded
token bucket** rather than Redis/Memorystore, because:

- **No new infra, scales to zero.** Firestore is already a dependency; there is
  no idle cost and no VPC connector to manage. Redis/Memorystore is always-on
  and needs a serverless VPC connector — both contradict the
  pay-nothing-between-contests goal.
- **Correct enough at our scale.** A contest is bursty but bounded (hundreds of
  candidates, not millions). The Firestore transaction throughput we need sits
  comfortably under the platform ceiling (see below).

## Mechanism

`makeJudge0Limiter(ctx)` returns `{ gate }`. `gate(key, submitFn)`:

1. hashes `key` (the session id, FNV-1a) onto one of `JUDGE0_LIMITER_SHARDS`
   shard documents (`proctor_judge0_ratelimit/shard-N`);
2. runs a Firestore **transaction** on that one shard doc: refill + try-consume
   one token (pure math, `tokenBucket.mjs`);
3. on success, runs `submitFn` (the actual Judge0 POST); on an empty bucket,
   throws a **429** carrying an honest refill-based `retry_after_seconds` —
   **before** any Judge0 call is made (that is the saved call).

The global `capacity`/`refillPerSec` are split **evenly across shards** so the
sum across shards equals the configured global limit. A caller always lands on
the same shard for a given session, so a single session's burst contends on one
doc rather than all S — and the **global** rate is what we cap.

It **composes** with the existing per-instance queue: `exec.mjs` passes
`submitGate: (fn) => judge0SubmitGate(sessionId, () => execQueue.enqueue…(fn))`,
so per-instance backpressure **and** the global cap both apply.

**Fail-open by design.** If Firestore itself errors (the limiter's own infra
hiccup), the submit is let through rather than blocking a live exam. The DoS
surface is already covered by the per-session exec cooldown + the queue lanes;
this limiter is the global smoothing layer, and a transient Firestore blip must
never wall off a contest.

## Default tuning (hosted RapidAPI Judge0 tier)

| Param                            | Default | Meaning                                  |
| -------------------------------- | ------- | ---------------------------------------- |
| `JUDGE0_LIMITER_CAPACITY`        | 40      | GLOBAL burst tokens                      |
| `JUDGE0_LIMITER_REFILL_PER_SEC`  | 10      | GLOBAL sustained submit rate (tokens/s)  |
| `JUDGE0_LIMITER_SHARDS`          | 10      | shard docs (contention spread)           |

So: **~10 Judge0 submit-POSTs/second sustained, with a 40-burst**, fleet-wide,
regardless of instance count. Per shard that is **1 token/s sustained, 4 burst**.
Set `JUDGE0_LIMITER_ENABLED=false` to bypass entirely.

These caps are deliberately conservative — they are sized to keep us under the
hosted Judge0 plan's request budget, not to maximize throughput. A self-hosted
Judge0 with more headroom can raise `REFILL_PER_SEC` (and `SHARDS` with it).

## Scale ceiling — when Firestore is no longer enough → move to Redis

**The ceiling is ~50 Judge0 submits/second sustained.**

The binding constraint is **Firestore's per-document write rate**: a hot document
sustains roughly **~1 sustained write/second** before contention/latency climbs
(short bursts go higher). Every consumed token is one transactional write to a
shard doc, so:

```
sustained submits/sec  ≈  SHARDS × (~1 sustained write/sec per shard doc)
```

- At the default **10 shards → ~10 submits/sec sustained** is the comfortable
  steady-state, which matches the default `REFILL_PER_SEC=10`. This is the
  intended operating point and has ample margin.
- Raising shards buys linear headroom **up to ~50 shards (~50 submits/sec)**.
  Beyond that, two things bite:
  1. transaction **contention + retries** on the shard docs grows non-linearly
     (a transaction that loses a race re-reads and retries, adding latency that
     shows up as slower submits, not just lower throughput); and
  2. the 500-writes/sec/collection ramp and the per-doc hot-spotting mean more
     shards yields diminishing returns while adding read+write cost per submit.

So **~50 submits/sec sustained** is the practical ceiling for the
Firestore-backed design. A contest would have to be pushing well past **3,000
submissions/minute fleet-wide** to reach it — far above any realistic
single-contest load (hundreds of candidates, each gated by a per-session submit
cooldown).

**If a deployment genuinely needs more than ~50 submits/sec sustained** (e.g. a
multi-thousand-candidate simultaneous contest, or many large contests sharing one
backend), migrate the shared state to **Redis/Memorystore**: an `INCR`/Lua token
bucket sustains 100k+ ops/sec on a single node and removes the per-doc write
ceiling. The `tokenBucket.mjs` math is storage-agnostic and ports unchanged — only
the transactional read/write in `judge0Limiter.mjs` swaps from a Firestore
transaction to a Redis call. The trade-off is the always-on Redis cost + VPC
connector that the Firestore design specifically avoids, so this is a deliberate
"we have outgrown serverless-cheap" decision, not a default.

## Cost note

Each gated submit is one small Firestore transaction (1 read + 1 write on a
~30-byte doc). At the default 10/s that is ~864k transactions/day in the worst
case of continuous saturation — pennies, and in practice far less because real
contests are bursty and idle between rounds. The limiter writes **nothing** when
`JUDGE0_LIMITER_ENABLED=false`.
