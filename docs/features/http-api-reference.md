# HTTP API Reference

This is the **canonical route reference** for the project (the
[architecture overview](architecture-overview.md#11-full-http-route-inventory-77-routes)
links here rather than duplicating it, and the root [`README.md`](../../README.md)
points operators here). **77 routes total**: **74** `/api/*` routes dispatched from
the `api` handler in `backend/src/handler.mjs` (route bodies decomposed into
`backend/src/routes/*.mjs` factories), plus the **3** `/eval-ui/*` pages served by
the separate proctor-eval entrypoint `backend/src/eval-server.mjs` (listed under
Evaluation below). Auth is timing-safe (`safeEqual`) and **closed-by-default** when
the secret is unset:

- **admin** = `x-admin-password` vs `ADMIN_PASSWORD`
- **invig** = `x-invigilator-password` vs the contest's `invigilator_key` OR
  `INVIGILATOR_PASSWORD` (admin password also accepted)
- **api-key** = `x-api-key` vs `ALERTS_INGEST_API_KEY`
- **sweep** = `x-api-key` vs `RETENTION_SWEEP_API_KEY` (or admin)
- **session** = knowing the `session_id` (no header) — the candidate write bearer

Any unmatched path → `404`. Intentional 4xx echo a `detail` message; unexpected
errors return a generic `500` with no internal detail. CORS allows
`GET,POST,OPTIONS` (`PUBLIC_APP_ORIGIN`, default `*`).

## Candidate / public

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/exam-config` | none | Public sanitized exam config for a contest/slug. |
| POST | `/api/access-code` | none | Resolve a typed 6-char access code → contest slug. |
| POST | `/api/roster/lookup` | none (rate-limited) | Verify a candidate's roster unique ID (person-mode may return a college picker). |
| POST | `/api/session/start` | time-window gate | Register/start a session, or idempotently replay an owned `session_id`. Serves `problems[]` + `submissions_summary` + `submit_budget`. |
| POST | `/api/session/resume` | session | Return an existing session verbatim after a reload (no re-collection). |
| POST | `/api/upload-url` | session (writable) | Mint a v4 signed **write** URL for a `screen` or `camera` chunk. |
| POST | `/api/events` | session (writable) | Append a JSONL event batch; raise sure-shot alerts for high-signal types. |
| POST | `/api/editor-events` | session (writable) | Ingest editor (keystroke/paste) events (cap `EDITOR_EVENTS_INGEST_LIMIT`). |
| POST | `/api/exec/run` | session (writable) | Run code against **sample** tests on Judge0 (visible results). |
| POST | `/api/exec/submit` | session (writable) | Submit against **hidden** tests (verdict + pass/fail counts only). |
| POST | `/api/review-file` | session (writable) | Store a review record set (`clipboard`/`tabs`/`cookies`). |
| POST | `/api/heartbeat` | session (writable) | Liveness + recording state + IP; raises `recording_stopped`/`ip_changed`; serves live enforcement config. |
| POST | `/api/session/beacon` | session (sendBeacon-friendly) | Liveness beacon (`hidden`/`visible`/`closing`); `hidden`/`closing` raise `tab_hidden`. |
| POST | `/api/session/room-gate` | session | Submit the invigilator room start code. |
| POST | `/api/session/enforcement-violation` | session | Report a fullscreen exit; server decides lock vs alert. |
| POST | `/api/session/unlock-gate` | session | Submit an invigilator unlock code to release a fullscreen lock. |
| POST | `/api/session/validate-end` | session (writable) | Pre-flight the end (requires `assurance_accepted:true`). |
| POST | `/api/session/end` | session (writable) | End the session, write `manifest.json`, release the live slot. |
| POST | `/api/submission-events` | session (writable) | Append submission-time timeline markers. |

## Admin — contests, templates, problems, roster

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/admin/contests` | List / create contests (create may use `template_slug`). |
| POST | `/api/admin/contest-update` · `contest-status` · `contest-regenerate` · `contest-set-code` · `contest-exam-time` | Update fields / status / regenerate codes / set a custom access code / set exam time. |
| GET | `/api/admin/templates` · `/api/admin/template` | List / read templates. |
| POST | `/api/admin/templates` · `template-update` · `template-archive` · `template-clone` · `template-delete` | Template CRUD. |
| GET | `/api/admin/problems` · `/api/admin/problem` | List / read problems (with hidden tests). |
| POST | `/api/admin/problems` · `problem-delete` | Save / delete a problem (live-reference guard). |
| GET/POST | `/api/admin/roster` | Read / upload a per-contest roster (college column → identity pipeline). |

## Admin — live monitoring, sessions, alerts

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/sessions` · `recording-sessions` · `sessions-list` · `session-detail` · `session-events` | Per-user sessions + evidence / recording picker / list / one-session detail / event stream. |
| POST | `/api/admin/session-action` · `session-details` | Bulk action (`approve`/`lock`/`unlock`/`bypass`/`end`/`exempt`) / per-user detail CSV. |
| GET | `/api/admin/submission-events` | Submission timeline markers for a session. |
| GET | `/api/admin/stats` | Counts by status (live/locked/pending/finished/disconnected) + rooms. |
| GET | `/api/admin/ip-report` · `attendance` | IP clustering drill-down / roster taken–not-taken. |
| POST | `/api/admin/health-check` | Pre-test pre-flight canary: stands up an ephemeral namespaced contest+session and probes signing / chunk upload / recordings read / telemetry write / bundle hash-gate / Judge0 reachability with real auth, then tears it down (`light` skips metered Judge0; `full` adds 2 submissions). |
| POST | `/api/admin/contest-exam-time` | Live end-time control for the scoped contest (absolute / extend / force-end-now). |
| POST | `/api/alerts` | Ingest one alert or a batch (`{alerts:[…]}`, idempotent on `alert.id`). |
| GET | `/api/admin/alerts` | List alerts newest-first with filters + `download_url` from `video_key`. |
| POST | `/api/admin/alert-action` | `archive`/`unarchive` a set of alert ids. |
| GET/POST | `/api/admin/alert-settings` | Read / upsert per-type proctor alert config. |

## Admin — results, people, recording review, lifecycle

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/contest-results` | Per-contest scoreboard (rank / per-problem / integrity). |
| POST | `/api/admin/contest-selection` · `contest-selection-done` | Bulk-select shortlist / finalize the selection snapshot. |
| GET | `/api/admin/people` · `/api/admin/person` | People directory (capped fan-out) / one person's cross-round scorecard. |
| POST | `/api/admin/contest-export` · `contest-purge` · `retention-sweep` | Export zip / triple-gated purge → tombstone / scheduled retention sweep. |
| POST/GET | `/api/admin/review-roster` · `review-next` · `review-verdict` · `review-mine` · `reviews` | Multi-reviewer recording-review queue (set roster / serve next / verdict / mine / list). |

> The recording **player** path (used by recording review and alert deep-links)
> resolves in both legacy and person-keyed modes. The distributed reviewer
> **queue** (`review-roster`/`review-next`/`review-verdict`) is candidate-norm-keyed;
> full person-mode queue serving is a roadmap item.

## Evaluation (proctor-eval `/eval-ui` + routes)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/admin/contest-evaluate` | Run the integrity + talent evaluation over a contest's sessions (batched). |
| GET | `/api/admin/contest-evaluations` · `contest-evaluate-status` | Read computed scorecards / poll batch status. |
| GET | `/eval-ui` · `/eval-ui/app.js` · `/eval-ui/recommend.js` | The embedded Evaluation tab page + its browser app + the pure recommendation module. |

## Invigilator (`backend/src/routes/invigilator.mjs`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/invigilator/overview` | Which rooms exist, gate on/off. |
| GET | `/api/invigilator/room` | Room stats + session rows + shared alerts. |
| POST | `/api/invigilator/release-code` · `open-room` | Release the 6-digit room start code / open the whole room. |
| POST | `/api/invigilator/exempt` | Per-student enforcement exemption toggle. |
| POST | `/api/invigilator/unlock-code` · `unlock` | Mint a fullscreen unlock code / unlock a specific session. |

## Shared alert contract

Every producer and the backend agree on this shape (required on ingest: `source`,
`type`, `severity`, `timestamp`, `hackerrank_username`, `title` — the wire field
name `hackerrank_username` is **frozen for back-compat**; the candidate-facing
label is "Candidate ID"). The fuller field-by-field reference lives in
[`alert-taxonomy.md`](alert-taxonomy.md).

```jsonc
{
  "id": "<source>:<type>:<username_norm>:<contest_slug>:<dedupe>", // stable + idempotent
  "source": "proctor | contest-eval",
  "type":   "<see alert taxonomy below>",
  "severity": "critical | warning | info",
  "timestamp": "<ISO 8601>",
  "contest_slug": "<optional>",
  "hackerrank_username": "<required (frozen wire name)>",
  "username_norm": "<lowercase/sanitized>",
  "person_id": "<optional; person-mode>",
  "session_id": "<optional>",
  "room": "<optional>",
  "title": "<headline>",
  "detail": "<optional explanation>",
  "data": { /* optional structured payload */ },
  "video_key": "<optional GCS key; resolved to download_url on READ, never stored>",
  "verdict": { "status": "pending | real | false_positive | inconclusive" }
}
```

For the full alert catalog — proctor and contest-eval types, default severities,
the per-type Share-with-invigilator flag, and the enforcement-violation lock ladder
— see [`alert-taxonomy.md`](alert-taxonomy.md).

## Related

- [`architecture-overview.md`](architecture-overview.md) — the single-page technical tour (links here for the route inventory).
- [`alert-taxonomy.md`](alert-taxonomy.md) — the full Alert contract and alert catalogs.
- [`../README.md`](../README.md) — the documentation index.
