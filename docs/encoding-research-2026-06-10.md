# F7 — Optimal recording encoding for proctor screen recordings

**Research doc — discussion deliverable, no implementation.**
Date: 2026-06-10. Researched against the live code (`frontend/src/useProctorRecorder.ts`, `backend/src/handler.mjs`, `video-worker/src/server.mjs`), Chromium source (main branch), real chunk data from `gs://aerele-proctor-dev-evidence`, and a local transcode experiment on a real session chunk.

---

## 1. Current state — verified, not assumed

Several "known facts" in the task brief turned out stale. Verified reality:

| Item | Brief said | Actual (verified in code / GCS) |
|---|---|---|
| Video bitrate target | ~930 kbps | **580 kbps** (`video_bits_per_second: 400000` + `media_bits_per_second: 180000`, summed in `useProctorRecorder.ts:559`) |
| Max width / fps | 1280 / 5 fps | **960 / 4 fps** (`handler.mjs` uploadConfig; sample chunk ffprobes as 960×540 @ 4fps VP9 + Opus) |
| Camera overlay composited into recording | yes | **No.** `startDirectScreenRecordingStream()` records the raw screen track + mic only. The canvas-composite code (`drawCompositeFrame`) is dead code — never invoked. Event log says `camera_overlay: "disabled_for_reliable_background_recording"`. Camera is preview-only; **camera evidence is not stored at all** (except incidentally when the candidate keeps the proctor page visible — the self-view is then part of the screen). |
| Chunking | 30 s timeslice blobs | **Fresh `MediaRecorder` per 30 s chunk** (stop → new instance). Each chunk is a complete standalone WebM with its own header + opening keyframe. Lost-chunk tolerance is by construction. There is a small (~100–300 ms) capture gap at each boundary. |
| Server worker | transcoder exists | `proctor-video-worker` only does **binary concat + ffmpeg remux (`-c copy`)** — no transcode today. |

### Measured baseline (real dev session, today, asia-south1)

Session `contests/challenges/sessions/test/2b8c6ca1.../screen/`, 30 s chunks:

- Chunk sizes 177–657 KB, **average ≈ 442 KB / 30 s ≈ 118 kbps actual** — far below the 612 kbps configured ceiling. `videoBitsPerSecond` is a VBR *target/cap*, not a floor; static screen content encodes to near-nothing.
- ffprobe of the busiest chunk (657 KB): VP9 960×540@4fps, 120 frames, **keyframes at 0 s and 25.26 s only** (Chrome's default = max 100 frames between keyframes → 25 s at 4 fps; the chunk restart provides the one at 0 s).
- Byte breakdown of that chunk: video 544 KB, of which **keyframes are only 17 KB (3%)** — keyframe overhead is *not* a cost driver. Audio = **108 KB ≈ 29 kbps, always-on** — in the *quietest* chunk (177 KB) audio is ~60% of the bytes. Audio is the floor of every idle minute.

**Per-candidate / per-exam storage at current settings:**

| Scenario | Per 2 h candidate | 500-candidate exam | GCS Standard asia-south1 (~$0.023/GB-mo) |
|---|---|---|---|
| Worst case (cap sustained, 612 kbps) | ~550 MB | ~275 GB | ~$6.3/month (~₹530) |
| **Measured average (~118 kbps)** | **~106 MB** | **~53 GB** | **~$1.2/month (~₹100)** |

(The brief's ~870 MB figure corresponds to the assumed 962 kbps cap; neither the actual cap nor — more importantly — actual VBR behaviour gets anywhere near it.)

**First takeaway: storage cost is already small.** The optimization story is about (a) review-download/egress speed, (b) scaling to many exams retained for months, (c) not paying for always-on audio and a stale +180k bitrate budget — not about rescuing an expensive bill.

---

## 2. What Chrome's encoder already does (Chromium source findings)

These change the option space materially:

1. **Screen-content tuning is already on.** MediaRecorder sets `is_screencast` from the track source (`video_track_recorder.cc` → `MediaStreamVideoTrack::is_screencast()`); for `getDisplayMedia` monitor tracks this is true. The encoder wrapper then sets `ContentHint::Screen` (`media_recorder_encoder_wrapper.cc`: `options_.content_hint = is_screencast ? ContentHint::Screen : ContentHint::Camera`), which maps to `VP9E_SET_TUNE_CONTENT = VP9E_CONTENT_SCREEN` for VP9, `VP8E_SET_SCREEN_CONTENT_MODE` for VP8, and `AV1E_SET_TUNE_CONTENT = AOM_CONTENT_SCREEN` **plus palette mode** for AV1 (`vpx_video_encoder.cc`, `av1_video_encoder.cc`).
   → **Setting `track.contentHint = "detail"/"text"` is a no-op for MediaRecorder.** The spec's contentHint encoder rules apply to RTCPeerConnection (and WebCodecs has its own `contentHint`); MediaRecorder keys off the capture source, and the screen tuning is already applied.
2. **Bitrate is VBR with 2× peak** (`VariableBitrate(target, 2×target)`), latency mode "Quality" — confirms target-as-cap semantics and explains the bitrate spikes others report ([addpipe bitrate study](https://blog.addpipe.com/mediarecorder-video-bitrates/), [chromium-dev VP9 spike thread](https://groups.google.com/a/chromium.org/g/chromium-dev/c/oDH3ibBsTfg)).
3. **Keyframes**: default max interval 100 frames (`key_frame_request_processor.cc`, `kDefaultKeyIntervalCount = 100`). Chromium also ships MediaRecorder options `videoKeyFrameIntervalDuration` / `videoKeyFrameIntervalCount` ([intent-to-ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/2ydi1kTIlp0)) — but since measured keyframe cost is 3% of bytes, **tuning this is not worth it**.
4. **AV1 recording works today**: `MediaRecorder.isTypeSupported('video/webm;codecs=av01.0.04M.08,opus')` → **true**, verified live on local Chrome 149. WebCodecs `VideoEncoder` also reports support for VP9/AV1 with `contentHint:"text"` and `bitrateMode:"quantizer"` (verified via `isConfigSupported`, hints echoed back).
5. **Low fps is nearly free already**: screen capture only produces frames on damage (plus refresh ticks), and an unchanged 960×540 inter-frame costs ~tens of bytes. Measured avg inter-frame on an *active* session: 4.5 KB. **Dropping 4 → 1–2 fps saves little** (the static periods already cost ~0) **and costs evidence**: a 0.5 s alt-tab flash is 2 frames at 4 fps, possibly 0 frames at 1 fps. Keep 4 fps.

---

## 3. Transcode experiment (measured, not literature)

Busiest real chunk (657 KB, 30 s, active UI usage), local ffmpeg:

| Encode | Size | Δ vs original | SSIM vs source | CPU (user-s per source-s) |
|---|---|---|---|---|
| Original (Chrome realtime VP9, screen-tuned) | 657 KB | — | — | (client-side) |
| `libvpx-vp9 -tune-content screen -deadline good -cpu-used 2 -crf 32` | 384 KB | **−42%** | 0.974 | 0.43 |
| `libsvtav1 -preset 6 -crf 38 -svtav1-params scm=1` | 259 KB | **−61%** | 0.976 | 0.38 |

Text legibility visually verified on extracted frame crops — small UI text identical to source at AV1 CRF 38. (Quiet chunks will shrink proportionally less because their bytes are mostly audio.) AV1 SCC tools (palette, IntraBC) are exactly built for this content class ([Visionular SCC analysis](https://visionular.ai/av1-screen-content-coding/): >50% vs realtime encoders for screen content; [SVT-AV1 scm guide](https://gist.github.com/BlueSwordM/86dfcb6ab38a93a524472a0cbe4c4100)).

**Cloud Run cost per 2 h session** (tier-1: $0.000024/vCPU-s, $0.0000025/GiB-s — [Cloud Run pricing](https://cloud.google.com/run/pricing)): 7200 s × ~0.4 vCPU-s ≈ 2900 vCPU-s ≈ **$0.07–0.16/session** (upper end allows for slower cloud vCPUs) + ~$0.01 memory. **500 candidates ≈ $35–80 one-time per exam** — only worth it if the raw chunks are then lifecycle-deleted, otherwise it *adds* storage.

---

## 4. Options compared

| # | Option | Effort | Risk | Size win (vs measured baseline) | Notes |
|---|---|---|---|---|---|
| A | **Config-only client tweaks** (backend `uploadConfig`): drop the dead `media_bits_per_second` +180k (overlay it budgeted for is disabled) → video cap 400k; `audioBitsPerSecond` 32k → 16k mono | Hours | Very low | ~10–20% avg (audio −12 MB/2h/candidate; video cap mostly trims scroll bursts) | Listen-check 16 kbps Opus speech first; Opus voice at 16k mono is generally fine |
| B | `track.contentHint = "detail"/"text"` | Trivial | None | **~0%** | No-op for MediaRecorder (§2.1). Don't bother |
| C | Keyframe interval tuning (`videoKeyFrameIntervalCount`) | Trivial | Low | ~2–3% | Measured keyframe share is 3%. Don't bother |
| D | Lower fps to 1–2 | Trivial | **Medium-high (evidence loss)** | Small (static frames ≈ free) | Rejected: hurts cheat-review granularity, saves little |
| E | **AV1 via MediaRecorder** (feature-detect `av01`, VP9 fallback) | Days | Medium: old Chrome on lab machines → must keep fallback; software libaom CPU at 4 fps/960px is small but unproven on weakest laptops | est. 25–50% on video bytes (client realtime AV1+palette vs realtime VP9) | Chromium MediaRecorder AV1 gets `AOM_CONTENT_SCREEN` + palette (§2.1). Pilot on a real lab machine before rollout |
| F | **WebCodecs custom pipeline** (`MediaStreamTrackProcessor` → `VideoEncoder` quantizer-mode + `AudioEncoder` → JS WebM muxer) | Weeks: muxing, A/V sync, error paths, chunk rotation, watchdogs | High: replaces the most battle-tested part of the pipeline; Chrome-only is fine (app already requires Chrome/Edge) but reliability regressions hit live exams | Marginal over E (constant-quality instead of VBR cap; could skip duplicate frames — but capture already does) | Not justified: Chrome already applies the screen tuning that WebCodecs would let us set by hand |
| G | **Server-side transcode in video-worker at merge time** (SVT-AV1 `scm=1` CRF ~38, or libvpx-vp9 `-tune-content screen` CRF ~32 for max playback compatibility) + lifecycle-delete raw chunks after N days | Days (worker already downloads/merges/uploads; add one ffmpeg step + Dockerfile codec check) | Low: raw chunks stay until lifecycle expiry; transcode is offline, re-runnable; AV1-in-WebM plays in Chrome/Edge `<video>` | **−42% (VP9) / −61% (AV1) measured** on top of any client win | ~$0.07–0.16/session CPU. Keeps client untouched — zero exam-day risk |
| H | **GCS lifecycle rules** (raw chunks → delete after merge+N days; merged file → Nearline after 30 d, Coldline after 90 d) | Hours | Very low (policy choice: retention window) | 2–6× on *cost* (Nearline ~$0.010, Coldline ~$0.004/GB-mo) without touching a single bit of video | Biggest ₹-per-effort lever given storage is the only recurring cost |

---

## 5. Recommendation — two tiers

### Tier 1 — quick wins (config + policy, no new code paths, can ship this week)
1. **`uploadConfig`**: `video_bits_per_second: 400000`, drop/zero `media_bits_per_second` (dead camera-overlay budget), `audio_bits_per_second: 16000` after a quick speech-quality listen test. Keep **4 fps**, keep **960** (pending open question 1), keep VP9, keep 30 s fresh-recorder chunks (the lost-chunk tolerance and per-chunk keyframe come from this pattern — don't switch to timeslice).
2. **GCS lifecycle**: delete raw chunks N days after a successful merge; age merged files to Nearline/Coldline. Decide N with the review-workflow owners.
3. **Do not** add `contentHint`, keyframe options, or fps reduction — measured no-ops or evidence-negative (§2, §4 B–D).

Expected: ~10–20% smaller sessions, 2–6× lower storage cost per retained exam, zero exam-day risk.

### Tier 2 — full pipeline (next iteration, biggest size win, still low risk)
4. **Transcode in `proctor-video-worker` at merge time**: merged VP9 → **SVT-AV1 `-preset 6 -crf 38 -svtav1-params scm=1`** (−61% measured; use libvpx-vp9 `-tune-content screen -crf 32` if any review client can't play AV1), copy/re-encode audio to 16k mono Opus, write back as today. Raw chunks remain the durability tier until lifecycle expiry.
5. **Pilot client AV1** (option E) on representative lab hardware: one exam with `av01` + VP9 fallback, measure chunk sizes + CPU + failure events. Promote only if the weakest machines hold 4 fps without encoder backpressure.
6. **Skip WebCodecs** unless a future requirement (e.g. constant-quality guarantee, client-side region-of-interest) appears that MediaRecorder cannot express.

Combined expectation: ~106 MB → **~30–45 MB per 2 h candidate** in hot storage only briefly, then pennies/month per exam in cold storage; review downloads ~2.5× faster.

## 6. Risks / guardrails

- **Text legibility floor**: at 960 px, CRF is the safety knob — VP9 CRF ≤32 / SVT-AV1 CRF ≤38 with scm kept text pixel-readable in the experiment (SSIM ~0.975, visual check). Validate per exam template once on real HackerRank content, not just our admin UI. Don't push CRF further without a side-by-side.
- **Bitrate cap floor**: 400 kbps cap is fine for UI/scroll; if candidates watch embedded video (motion), VBR will hit the cap and smear — acceptable for proctoring (motion ≠ text evidence), but note it.
- **Seek/scrub**: keyframes every ≤25 s + chunk boundary every 30 s today → merged-file seeks land within ~25 s and `<video>` decodes forward from the previous keyframe (sub-second at 4 fps). Server transcode must keep `-g` ≤ ~240 frames (60 s) so scrubbing stays snappy; SVT-AV1's default gop (~161 frames ≈ 40 s at 4 fps) is fine.
- **Chunk-loss tolerance**: preserved untouched in Tier 1/2 (client pattern unchanged; transcode happens after merge on the server). Any future client rewrite (E/F) must keep "every chunk independently decodable".
- **Camera overlay motion forcing bitrate**: currently moot — overlay is disabled and camera is never recorded. If camera recording is ever re-enabled, record it as a *separate* low-res track/file rather than re-compositing into the screen (compositing forces canvas repaint at rAF rate and breaks the static-screen economy).

## 7. Open questions for Karthi

1. **960 vs 1280 width**: brief assumed 1280; config says 960. Is 960 a deliberate legibility/size call? At these VBR rates, 1280 would cost maybe +30–50% bytes but make small code text noticeably more readable in review. If reviewers ever zoom-squint, this is the cheapest review-quality upgrade — opposite direction from shrinking.
2. **Retention policy**: how long must raw chunks vs merged video survive (dispute window? client contract?). Lifecycle rules (the biggest cost lever) are blocked only on this number.
3. **Camera evidence**: is "camera never recorded" the intended product behaviour, or an accident of the overlay-disable fix? (Out of scope for encoding, but it fell out of the code read and seems worth a deliberate decision.)
4. **Audio**: is mic audio actually used in reviews? If rarely, 16k mono — or even dropping audio into a separate opt-in track — changes the floor of every idle minute.
5. **AV1 playback in the review UI**: review is browser `<video>` (Chrome/Edge fine). Any reviewer on Safari/old Edge? That decides SVT-AV1 vs libvpx-vp9 for the worker transcode.

---

## Appendix — sources

- Code: `/home/karthi/arogara/proctor/frontend/src/useProctorRecorder.ts`, `/home/karthi/arogara/proctor/backend/src/handler.mjs` (uploadConfig L183), `/home/karthi/arogara/proctor/video-worker/src/server.mjs`.
- Measurements: `gs://aerele-proctor-dev-evidence/contests/challenges/sessions/test/2b8c6ca1-.../screen/` (chunk listing + ffprobe); transcode artifacts at `/tmp/f7-vp9-crf32.webm`, `/tmp/f7-av1-crf38.webm`, frame crops `/tmp/f7-*-crop.png`. Live feature-detect on Chrome 149 via DevTools (`isTypeSupported`, `VideoEncoder.isConfigSupported`).
- Chromium source (main): [media_recorder_encoder_wrapper.cc](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/mediarecorder/media_recorder_encoder_wrapper.cc) (ContentHint::Screen, VBR 2× peak, AV1 in supported list), [vpx_video_encoder.cc](https://github.com/chromium/chromium/blob/main/media/video/vpx_video_encoder.cc) (VP9E_CONTENT_SCREEN), [av1_video_encoder.cc](https://github.com/chromium/chromium/blob/main/media/video/av1_video_encoder.cc) (AOM_CONTENT_SCREEN + palette), [key_frame_request_processor.cc](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/mediarecorder/key_frame_request_processor.cc) (default 100 frames), [video_track_recorder.cc](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/mediarecorder/video_track_recorder.cc) (is_screencast from track), [media_recorder.cc](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/mediarecorder/media_recorder.cc) (videoKeyFrameInterval options).
- Specs/docs: [W3C mst-content-hint](https://www.w3.org/TR/mst-content-hint/) (RTC-scoped degradation prefs; AV1 text-mode note), [WebCodecs spec](https://www.w3.org/TR/webcodecs/) + [VideoEncoderConfig.contentHint explainer](https://gist.github.com/Djuffin/c3742404b7c53ada227849c8b2b76b4c), [MediaRecorder keyframe configurability intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/2ydi1kTIlp0), [WebCodecs AV1 SCC intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/BLAW7YO17jE), [MDN videoBitsPerSecond](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/videoBitsPerSecond), [addpipe MediaRecorder bitrate study](https://blog.addpipe.com/mediarecorder-video-bitrates/), [VP9 encoding guide](https://developers.google.com/media/vp9/settings/vod), [SVT-AV1 guide (scm)](https://gist.github.com/BlueSwordM/86dfcb6ab38a93a524472a0cbe4c4100), [Visionular AV1 SCC](https://visionular.ai/av1-screen-content-coding/), [caniuse WebCodecs](https://caniuse.com/webcodecs) (Firefox 130+ desktop, Safari full 26+), [Cloud Run pricing](https://cloud.google.com/run/pricing), [GCS pricing](https://cloud.google.com/storage/pricing).
