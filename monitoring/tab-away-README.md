# tab-away detector — LOCAL image-recognition "candidate left HackerRank" (Stretch 1)

`tab_away_detector.py` watches a **screen-capture recording** (`.webm`) of a coding
session and flags continuous spans where the **HackerRank header logo is ABSENT** —
i.e. the candidate navigated away from HackerRank (switched tab/window, opened
another site). Each flagged span becomes a shared-contract **`tab_away` Alert**
(`source: proctor`, `severity: warning`) POSTed to the proctor backend
(`/api/alerts`), deep-linking the recording at the moment the candidate left.

It is **fully local** — no cloud vision API. Frame sampling is ffmpeg; matching is
OpenCV if present, else a pure numpy+Pillow normalized cross-correlation.

## How it works

1. **Sample frames** every `--interval` seconds via ffmpeg
   (`ffmpeg -i in.webm -vf fps=1/5 frame_%05d.png`) into a temp dir under the
   gitignored `monitoring/.data/`.
2. **Template-match the logo** in the configurable header **region** (top-left band
   by default) on each frame → a score in `[0,1]` (1 == perfect match).
3. **Detect absent runs**: continuous frames scoring **below `--threshold`** for
   longer than `--min-gap-seconds` (default **12s** — see *Threshold source of
   truth* below).
4. **Build + POST one `tab_away` Alert per run** with the gap start mapped to a
   wall-clock offset, a human `detail`, `data` (start/end offsets + per-frame
   scores), and `video_key` + `download_url` deep-linking the recording at the gap.

## Imaging backend (auto-detected)

| Priority | Backend | Match method | Status in this env |
|----------|---------|--------------|--------------------|
| 1 | OpenCV (`cv2`) | `cv2.matchTemplate` (`TM_CCOEFF_NORMED`) | **not installed** |
| 2 | numpy + Pillow | pure sliding-window NCC over the cropped region | **ACTIVE** (numpy 2.x + Pillow 12.x) |
| 3 | neither | documented stub — raises with `pip install` guidance | n/a |

The module **imports cleanly under all three**; frame extraction (ffmpeg) works
regardless and only the matching step needs an imaging lib. To get the faster/more
robust path: `pip install opencv-python` (the code switches automatically).

## Run it on a real recording

```bash
python3 monitoring/tab_away_detector.py \
  --video    /path/to/session.webm \
  --logo     /path/to/hackerrank-logo-crop.png \
  --username <candidate_hr_username> \
  --contest-slug <contest-slug> \
  --video-key   screen/<session_id>/merged.webm \
  --download-url 'https://<signed-or-cdn-url>/merged.webm' \
  --api-base  http://127.0.0.1:8080 \
  --api-key   "$ALERTS_INGEST_API_KEY"
```

Add `--dry-run` (alias `--no-post`) to analyze and print alerts **without POSTing**,
and `--json` to emit the full `{summary, alerts, posted}` to stdout. `--keep-frames`
(with `--frames-dir`) retains sampled frames for tuning.

## Tuning knobs

| Flag | Default | What it does |
|------|---------|--------------|
| `--interval` | `5` | seconds between sampled frames. Smaller = finer gap resolution, more CPU. The Nth frame (1-based) is at offset `(N-1)*interval` s. |
| `--threshold` | `0.6` | match score below this == logo **absent**. Raise if false "present" on busy headers; lower if real absences are missed. Inspect scores with `--json`. |
| `--region` | `top-left` | header band to search. Presets: `top-left`, `top-band`, `top-center`, `full`. Or pass `x0,y0,x1,y1` **fractions** in `[0,1]`, e.g. `--region 0,0,0.25,0.10`. **The logo crop must fit inside this region.** |
| `--min-gap-seconds` | `12` | minimum continuous absent span to flag. **Default = 12s, sourced from the admin console** (see below). Exposed as a knob so short test clips (and stricter/looser policies) are configurable. |
| `--admin-password` | — | when set with `--api-base` and **without** an explicit `--min-gap-seconds`, the threshold is read live from `GET /api/admin/alert-settings`. |
| `--base-offset` | `0` | wall-clock offset (s) of sampling-time 0 into a longer **merged** recording, so offsets/deep-links map to the full review video. |

### Threshold source of truth (`threshold_seconds`)

The **admin console is the source of truth** for the tab-away threshold:
**Settings → Proctor alert types → `tab_away` → threshold (seconds)** (default
**12**, validated as a positive number, stored with the rest of the alert-settings
and round-tripped through `GET`/`POST /api/admin/alert-settings` as
`proctor.tab_away.threshold_seconds`).

Wire it to the detector one of two ways:

1. **Pass it explicitly** — read the value from the console and run with
   `--min-gap-seconds <threshold_seconds>`. This always wins (operator override).
2. **Let the detector read it** — give `--api-base` + `--admin-password` and
   **omit** `--min-gap-seconds`; the detector does a one-shot
   `GET /api/admin/alert-settings` and uses
   `proctor.tab_away.threshold_seconds`. If the read fails (network/parse), it
   falls back to the built-in default (**12**). An explicit `--min-gap-seconds`
   always takes precedence over the API read.

Precedence: explicit `--min-gap-seconds` → live admin-console value (when
`--admin-password` given) → built-in default `12`.

### Picking the logo crop and region (important)

* The `--logo` crop must have **internal contrast/structure** (a flat, single-color
  crop has zero correlation norm and can never match) and must be **smaller than the
  search region**. Snip it tightly around the HackerRank wordmark/logo from an actual
  recording frame, including a little surrounding background.
* If the logo crop is larger than the region the matcher down-scales it (nearest-
  neighbour), which weakens the score — prefer a region that comfortably contains
  the logo, or a tighter crop.

## Alert shape (shared contract)

```jsonc
{
  "id": "proctor:tab_away:<username_norm>:<contest_slug>:tabaway-<start>-<end>",
  "source": "proctor",
  "type": "tab_away",
  "severity": "warning",
  "timestamp": "<ISO 8601>",
  "hackerrank_username": "<raw>",
  "username_norm": "<normalized>",
  "title": "Tab-away: HackerRank not visible for <N>s",
  "detail": "HackerRank header logo absent for <N>s ... starting at <T>s ...",
  "contest_slug": "<slug>",
  "video_key": "screen/<session>/merged.webm",        // deep-link target
  "download_url": "<base>#t=<gap-start-seconds>",      // see deep-link note below
  "data": {
    "start_offset": <sec>, "end_offset": <sec>, "duration_seconds": <sec>,
    "interval_seconds": <sec>, "threshold": <x>, "match_scores": [...],
    "start_frame_index": <i>, "end_frame_index": <j>,
    "deep_link_fragment": "#t=<gap-start-seconds>"
  },
  "verdict": { "status": "pending" }
}
```

Required-on-ingest fields (`source, type, severity, timestamp, hackerrank_username,
title`) and the id convention match `backend/src/handler.mjs`. The id is **stable +
idempotent** (re-running merges instead of duplicating). The client mirror
`alerts.validate_alert()` is run before POST.

### Deep-link convention (`#t=<seconds>`)

The gap-start deep link uses a **W3C Media Fragment** `#t=<seconds>` appended to the
recording URL, so a reviewer opening `download_url` jumps straight to where the
candidate left HackerRank. The exact offset is also in `data.deep_link_fragment` and
`data.start_offset`.

Note: the backend **re-resolves `download_url` on read** from `video_key` (a fresh
signed URL) and does **not persist** the emitted `download_url`. We still emit the
`#t=`-fragmented URL so **dry-run / direct consumers** get the precise offset; the
durable deep-link target the dashboard relies on is `video_key` + `data.start_offset`
(the console can append the `#t=` itself).

## Self-test (no real sample needed)

```bash
python3 monitoring/test_tab_away.py      # exits nonzero on any failure
```

It synthesizes — with ffmpeg only — a structured "logo" crop and a short
PRESENT/ABSENT/PRESENT `.webm`, then asserts the detector flags exactly the middle
no-logo span as a `tab_away` alert, the alert obeys the contract + deep-link
convention, the offsets line up, and a logo-present-throughout clip flags **nothing**
(negative control). It uses `--min-gap-seconds` low so the seconds-long synthetic gap
fires; the **default 12s threshold (sourced from the admin console) is unchanged**.

Does not touch the network or the real backend. Keeps existing
`python3 monitoring/test_monitoring.py` passing.

## HELD for Karthi (final accuracy tuning)

The synthetic test proves the **pipeline and contract** are correct, but real-world
accuracy tuning needs:

1. **A real screen recording** (`.webm`) of a HackerRank coding session — ideally one
   that includes a genuine tab-away.
2. **A canonical HackerRank-logo crop** (tight PNG snipped from a real header frame).

With those, tune `--region` (to the real header position/size), `--threshold` (read
real present-vs-absent scores via `--json`), and `--interval`, then confirm true
positives/negatives before enabling POST in production.
```
