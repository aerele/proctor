# video-worker/ — merge screen chunks into review videos (Cloud Run)

An optional Cloud Run HTTP service (`src/server.mjs`) that stitches a session's
30-second screen chunks into one playable review video. The backend uploads
chunks as `…/screen/chunk-NNNNN.webm`; this worker downloads them in order,
binary-concatenates, remuxes with `ffmpeg` (`-c copy`, regenerating timestamps),
probes duration with `ffprobe`, and uploads the merged `.webm` + a manifest JSON.

It **scans both storage layouts** — the legacy `sessions/<user>/<sid>/…` and the
Phase-2 contest-foldered `contests/<slug>/sessions/<user>/<sid>/…` — and writes
the merged output beside the chunks it came from. After a successful merge it
writes `merged_video_key` (and `merged_at`) back onto the session doc in
Firestore (best-effort), which is what the backend's sure-shot alerts deep-link to.

Routes:
- `GET /health` — liveness.
- `POST /merge` — bearer/`x-worker-token`-authenticated. Body `{ username }` or
  `{ usernames: [...] }` (capped at `MAX_USERNAMES_PER_REQUEST`, default 25).
  Returns one result per merged session.

Env vars: `SOURCE_BUCKET` (where chunks live; usually the evidence bucket),
`DEST_BUCKET` (review-video bucket), `WORKER_TOKEN` (auth), `SESSION_COLLECTION`
(must match the backend), `MAX_USERNAMES_PER_REQUEST`, `PORT`.

> CAVEAT (untested against real GCP, see [`../night-run/MORNING-REVIEW.md`](../night-run/MORNING-REVIEW.md)):
> if `DEST_BUCKET` ≠ `EVIDENCE_BUCKET`, the backend signs alert `video_key`
> against the evidence bucket and the deep-link can 404. Decide whether to merge
> into the evidence bucket or teach the backend the review-video bucket.

Deploy: `video-worker/deploy-gcp.sh` (creates `DEST_BUCKET`, grants IAM, deploys).
A local one-shot helper exists at `scripts/merge-gcs-videos.mjs`. Run `npm run
check` (`node --check`) for a quick syntax pass. The worker needs `ffmpeg`/`ffprobe`
on PATH (provided by its `Dockerfile`).
