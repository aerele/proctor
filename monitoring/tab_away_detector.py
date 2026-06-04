#!/usr/bin/env python3
"""tab_away_detector — LOCAL image-recognition "tab-away" detector (Stretch 1).

Given a screen-capture recording (.webm) of a HackerRank coding session, sample
frames at a fixed interval via ffmpeg, look for the HackerRank logo in the header
band (top-left by default), and flag CONTINUOUS runs where the logo is ABSENT for
longer than a threshold (default 60s) as the candidate having navigated AWAY from
HackerRank (switched tab / window / opened another site).

Each such run becomes a SHARED-CONTRACT Alert:
    source   = "proctor"
    type     = "tab_away"
    severity = "warning"
with the gap start mapped to a wall-clock offset, a human `detail`, structured
`data` (start/end offsets + the per-frame match scores), and a `video_key` +
`download_url` that DEEP-LINK the recording at the gap start via a `#t=<seconds>`
media fragment (the documented deep-link convention — see tab-away-README.md).

Alerts are POSTed to <api-base>/api/alerts with header x-api-key, reusing the
existing poller's POST helper + the shared contract validator.

------------------------------------------------------------------------------
IMAGING BACKEND (auto-detected at import; design adapts to what is installed)
------------------------------------------------------------------------------
  1. OpenCV (cv2)        -> cv2.matchTemplate (TM_CCOEFF_NORMED). Fastest/most
                            robust if present. (NOT installed in this env.)
  2. numpy + Pillow      -> pure normalized cross-correlation (NCC) over the
                            cropped header region. THIS is the backend used here
                            (numpy 2.x + Pillow 12.x are present).
  3. neither             -> a documented STUB backend that raises a clear error
                            telling you exactly what to `pip install`. The CLI
                            and alert-building interface still import cleanly so
                            the surrounding plumbing can be exercised.

Frame extraction always uses ffmpeg (no imaging lib needed for that), so the
"no imaging lib" path still extracts frames and only fails at the matching step.

Run `python3 monitoring/tab_away_detector.py --help` for the CLI.
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# Reuse the existing poster + the shared-contract helpers from the poller stack.
from poller import post_alerts                          # noqa: E402
from alerts import normalize_username, validate_alert, _now_iso  # noqa: E402


# ---------------------------------------------------------------------------
# imaging backend auto-detection
# ---------------------------------------------------------------------------
_BACKEND = None        # "cv2" | "numpy" | "stub"
_cv2 = None
_np = None
_Image = None

try:
    import cv2 as _cv2  # type: ignore
    _BACKEND = "cv2"
except Exception:  # noqa: BLE001
    try:
        import numpy as _np  # type: ignore
        from PIL import Image as _Image  # type: ignore
        _BACKEND = "numpy"
    except Exception:  # noqa: BLE001
        _BACKEND = "stub"


def backend_name():
    """Public accessor so callers/tests can report the active imaging backend."""
    return _BACKEND


# ---------------------------------------------------------------------------
# region presets — fraction-of-frame (x0, y0, x1, y1) in [0,1]. The HackerRank
# header logo sits in the top-left band; presets are configurable via --region.
# ---------------------------------------------------------------------------
REGION_PRESETS = {
    "top-left":   (0.00, 0.00, 0.30, 0.12),
    "top-band":   (0.00, 0.00, 1.00, 0.12),
    "top-center": (0.35, 0.00, 0.65, 0.12),
    "full":       (0.00, 0.00, 1.00, 1.00),
}


def parse_region(spec):
    """A preset name OR 'x0,y0,x1,y1' fractions. Returns a 4-tuple of floats."""
    if spec in REGION_PRESETS:
        return REGION_PRESETS[spec]
    parts = [p.strip() for p in str(spec).split(",")]
    if len(parts) == 4:
        x0, y0, x1, y1 = (float(p) for p in parts)
        if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
            raise ValueError(f"region fractions out of order/range: {spec!r}")
        return (x0, y0, x1, y1)
    raise ValueError(
        f"--region must be a preset {sorted(REGION_PRESETS)} or 'x0,y0,x1,y1' "
        f"fractions in [0,1]; got {spec!r}")


# ---------------------------------------------------------------------------
# ffmpeg: frame sampling
# ---------------------------------------------------------------------------
def _have_ffmpeg():
    return shutil.which("ffmpeg") is not None


def extract_frames(video_path, out_dir, interval, ffmpeg="ffmpeg"):
    """Sample one frame every `interval` seconds into out_dir/frame_%05d.png.

    Returns a sorted list of Path objects. ffmpeg numbers frames from 1, so the
    Nth file (1-based) is at wall-clock offset (N-1)*interval seconds.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    fps = f"1/{interval}" if interval >= 1 else f"{1/interval:g}"
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video_path),
        "-vf", f"fps={fps}",
        str(out_dir / "frame_%05d.png"),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg frame extraction failed (rc={proc.returncode}): "
            f"{proc.stderr.strip()[:500]}")
    return sorted(out_dir.glob("frame_*.png"))


# ---------------------------------------------------------------------------
# template matching — returns a score in [0,1] (1 == perfect match)
# ---------------------------------------------------------------------------
class StubBackendError(RuntimeError):
    pass


def _crop_region(arr_h, arr_w, region):
    x0, y0, x1, y1 = region
    cx0, cy0 = int(x0 * arr_w), int(y0 * arr_h)
    cx1, cy1 = max(cx0 + 1, int(x1 * arr_w)), max(cy0 + 1, int(y1 * arr_h))
    return cx0, cy0, cx1, cy1


def _to_gray_np(img_path):
    """Load an image as a float32 grayscale numpy array (numpy/Pillow backend)."""
    im = _Image.open(img_path).convert("L")
    return _np.asarray(im, dtype=_np.float32)


def _ncc_max(haystack, needle):
    """Max normalized cross-correlation of `needle` slid over `haystack`.

    Pure-numpy sliding-window NCC. Returns a score in [-1, 1]; we clamp to
    [0, 1] downstream. `needle` must fit inside `haystack`.
    """
    H, W = haystack.shape
    h, w = needle.shape
    if h > H or w > W:
        # needle bigger than search region -> cannot match; resize needle down.
        scale = min(H / h, W / w)
        new_hw = (max(1, int(h * scale)), max(1, int(w * scale)))
        needle = _resize_np(needle, new_hw)
        h, w = needle.shape
    n = needle - needle.mean()
    n_norm = float(_np.sqrt((n * n).sum()))
    if n_norm == 0:
        return 0.0
    best = -1.0
    # Stride keeps the pure-python loop bounded on large frames; sub-pixel
    # precision is unnecessary for "is the logo present at all".
    ys = range(0, H - h + 1, max(1, (H - h) // 64 + 1))
    xs = range(0, W - w + 1, max(1, (W - w) // 64 + 1))
    for y in ys:
        for x in xs:
            patch = haystack[y:y + h, x:x + w]
            p = patch - patch.mean()
            p_norm = float(_np.sqrt((p * p).sum()))
            if p_norm == 0:
                continue
            score = float((p * n).sum() / (p_norm * n_norm))
            if score > best:
                best = score
    return best


def _resize_np(arr, hw):
    """Nearest-neighbour resize without scipy/PIL (operates on a float array)."""
    H, W = arr.shape
    nh, nw = hw
    ys = (_np.arange(nh) * (H / nh)).astype(int).clip(0, H - 1)
    xs = (_np.arange(nw) * (W / nw)).astype(int).clip(0, W - 1)
    return arr[ys][:, xs]


def match_logo(frame_path, logo_path, region):
    """Return the best logo match score in [0,1] for the header region.

    cv2 backend uses TM_CCOEFF_NORMED; numpy backend uses sliding NCC; stub
    backend raises with install guidance.
    """
    if _BACKEND == "cv2":
        frame = _cv2.imread(str(frame_path), _cv2.IMREAD_GRAYSCALE)
        if frame is None:
            raise RuntimeError(f"cv2 could not read frame {frame_path}")
        H, W = frame.shape
        cx0, cy0, cx1, cy1 = _crop_region(H, W, region)
        crop = frame[cy0:cy1, cx0:cx1]
        templ = _cv2.imread(str(logo_path), _cv2.IMREAD_GRAYSCALE)
        if templ is None:
            raise RuntimeError(f"cv2 could not read logo {logo_path}")
        th, tw = templ.shape
        ch, cw = crop.shape
        if th > ch or tw > cw:
            scale = min(ch / th, cw / tw) * 0.95
            templ = _cv2.resize(templ, (max(1, int(tw * scale)), max(1, int(th * scale))))
        res = _cv2.matchTemplate(crop, templ, _cv2.TM_CCOEFF_NORMED)
        _, max_val, _, _ = _cv2.minMaxLoc(res)
        return max(0.0, float(max_val))

    if _BACKEND == "numpy":
        frame = _to_gray_np(frame_path)
        H, W = frame.shape
        cx0, cy0, cx1, cy1 = _crop_region(H, W, region)
        crop = frame[cy0:cy1, cx0:cx1]
        templ = _to_gray_np(logo_path)
        score = _ncc_max(crop, templ)
        return max(0.0, score)

    raise StubBackendError(
        "No imaging backend available: install OpenCV (`pip install opencv-python`) "
        "OR numpy+Pillow (`pip install numpy pillow`) to run template matching. "
        "Frame extraction (ffmpeg) and alert building work without it.")


# ---------------------------------------------------------------------------
# gap detection over the per-frame score series
# ---------------------------------------------------------------------------
def find_absent_runs(scores, interval, threshold, min_gap_seconds):
    """Find continuous runs of frames whose score < threshold lasting longer
    than min_gap_seconds.

    A run of K consecutive absent frames spans frames [i .. i+K-1]. The candidate
    is "away" from the first absent frame; presence resumes at the next present
    frame. We measure the gap as the time from the first absent frame's offset to
    the offset of the first PRESENT frame after it (or end-of-video). This counts
    the inter-frame spacing correctly: K absent frames followed by a present one
    is a K*interval-second gap.

    Returns a list of dicts: {start_index, end_index, start_offset, end_offset,
    duration, scores}. Indices are 0-based into `scores`.
    """
    runs = []
    n = len(scores)
    i = 0
    while i < n:
        if scores[i] >= threshold:
            i += 1
            continue
        j = i
        while j < n and scores[j] < threshold:
            j += 1
        # absent frames are [i .. j-1]; first present frame (if any) is j.
        start_offset = i * interval
        if j < n:
            end_offset = j * interval        # presence resumes here
        else:
            end_offset = n * interval        # ran to end-of-sampling
        duration = end_offset - start_offset
        if duration > min_gap_seconds:
            runs.append({
                "start_index": i,
                "end_index": j - 1,
                "start_offset": round(start_offset, 3),
                "end_offset": round(end_offset, 3),
                "duration": round(duration, 3),
                "scores": [round(float(s), 4) for s in scores[i:j]],
            })
        i = j
    return runs


# ---------------------------------------------------------------------------
# deep-link + alert construction
# ---------------------------------------------------------------------------
def deep_link(download_url_base, video_key, start_offset):
    """Build the deep-link URL at the gap start using a `#t=<seconds>` media
    fragment (W3C Media Fragments). If a base url is given we append the
    fragment; otherwise we return None and rely on video_key + data.start_offset.
    """
    if not download_url_base:
        return None
    sep = "" if "#t=" in download_url_base else f"#t={int(round(start_offset))}"
    return f"{download_url_base}{sep}"


def build_tab_away_alert(run, *, username, contest_slug, video_key,
                         download_url_base, interval, threshold, timestamp=None,
                         base_offset=0.0):
    """Build one shared-contract `tab_away` Alert dict for an absent run.

    `base_offset` lets the caller map sampling-offset 0 to a wall-clock offset
    into a longer merged recording (default 0 == recording starts at the clip).
    """
    norm = normalize_username(username)
    slug = contest_slug or "_"
    start = run["start_offset"] + base_offset
    end = run["end_offset"] + base_offset
    dedupe = f"tabaway-{int(round(start))}-{int(round(end))}"
    aid = f"proctor:tab_away:{norm}:{slug}:{dedupe}"
    dl = deep_link(download_url_base, video_key, start)
    mins = run["duration"] / 60.0
    detail = (
        f"HackerRank header logo absent for {run['duration']:.0f}s "
        f"({mins:.1f} min) starting at {int(start)}s into the recording "
        f"(frames {run['start_index']}-{run['end_index']}, match scores "
        f"{min(run['scores']):.2f}-{max(run['scores']):.2f} < threshold {threshold}). "
        f"Candidate likely navigated away from HackerRank (tab/window switch).")
    alert = {
        "id": aid,
        "source": "proctor",
        "type": "tab_away",
        "severity": "warning",
        "timestamp": timestamp or _now_iso(),
        "hackerrank_username": str(username),
        "username_norm": norm,
        "title": f"Tab-away: HackerRank not visible for {run['duration']:.0f}s",
        "detail": detail,
        "data": {
            "start_offset": round(start, 3),
            "end_offset": round(end, 3),
            "duration_seconds": round(run["duration"], 3),
            "interval_seconds": interval,
            "threshold": threshold,
            "match_scores": run["scores"],
            "start_frame_index": run["start_index"],
            "end_frame_index": run["end_index"],
            "deep_link_fragment": f"#t={int(round(start))}",
        },
        "verdict": {"status": "pending"},
    }
    if contest_slug:
        alert["contest_slug"] = contest_slug
    if video_key:
        alert["video_key"] = video_key
    if dl:
        # download_url is normally re-resolved server-side from video_key; we
        # still emit the deep-linked URL so dry-run / direct consumers get the
        # exact `#t=` offset. Documented in tab-away-README.md.
        alert["download_url"] = dl
    return alert


# ---------------------------------------------------------------------------
# top-level: analyze a recording -> list of tab_away alerts
# ---------------------------------------------------------------------------
def analyze_recording(video_path, logo_path, *, interval, threshold, region,
                      min_gap_seconds, username, contest_slug, video_key,
                      download_url_base, base_offset=0.0, frames_dir=None,
                      keep_frames=False, ffmpeg="ffmpeg"):
    """Extract frames, score each against the logo, find absent runs, build alerts.

    Returns (alerts, summary). `summary` carries the score series + backend for
    logging/testing. Frames go under frames_dir (a gitignored .data/ subdir by
    default) and are removed unless keep_frames is set.
    """
    if not _have_ffmpeg():
        raise RuntimeError("ffmpeg not found on PATH; required for frame sampling.")
    video_path = Path(video_path)
    if not video_path.exists():
        raise FileNotFoundError(f"video not found: {video_path}")
    if logo_path is None:
        raise ValueError(
            "a canonical HackerRank-logo crop (--logo PATH) is required for "
            "template matching. (HELD: Karthi to provide a real logo crop.)")
    logo_path = Path(logo_path)
    if not logo_path.exists():
        raise FileNotFoundError(f"logo crop not found: {logo_path}")

    region_t = region if isinstance(region, tuple) else parse_region(region)

    tmp_owner = None
    if frames_dir is None:
        tmp_owner = tempfile.mkdtemp(prefix="frames-", dir=str(HERE / ".data"))
        frames_dir = tmp_owner
    frames_dir = Path(frames_dir)

    try:
        frames = extract_frames(video_path, frames_dir, interval, ffmpeg=ffmpeg)
        if not frames:
            raise RuntimeError("ffmpeg produced no frames (is the video empty?)")
        scores = [match_logo(f, logo_path, region_t) for f in frames]
        runs = find_absent_runs(scores, interval, threshold, min_gap_seconds)
        alerts = [
            build_tab_away_alert(
                r, username=username, contest_slug=contest_slug,
                video_key=video_key, download_url_base=download_url_base,
                interval=interval, threshold=threshold, base_offset=base_offset)
            for r in runs
        ]
        summary = {
            "backend": _BACKEND,
            "n_frames": len(frames),
            "interval": interval,
            "threshold": threshold,
            "region": region_t,
            "min_gap_seconds": min_gap_seconds,
            "scores": [round(float(s), 4) for s in scores],
            "n_runs": len(runs),
            "n_alerts": len(alerts),
        }
        return alerts, summary
    finally:
        if tmp_owner and not keep_frames:
            shutil.rmtree(tmp_owner, ignore_errors=True)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_argparser():
    p = argparse.ArgumentParser(
        description="LOCAL tab-away detector: flag continuous spans where the "
                    "HackerRank logo is absent from a screen recording.")
    p.add_argument("--video", required=True, help="screen-capture recording (.webm)")
    p.add_argument("--logo", default=None,
                   help="canonical HackerRank-logo crop image (PNG). REQUIRED to "
                        "actually run matching (HELD: Karthi to provide).")
    p.add_argument("--interval", type=float, default=5.0,
                   help="seconds between sampled frames (default 5)")
    p.add_argument("--threshold", type=float, default=0.6,
                   help="match score below this == logo ABSENT (default 0.6)")
    p.add_argument("--region", default="top-left",
                   help=f"header region: a preset {sorted(REGION_PRESETS)} or "
                        f"'x0,y0,x1,y1' fractions (default top-left)")
    p.add_argument("--min-gap-seconds", type=float, default=60.0,
                   help="minimum continuous absent span to flag (production "
                        "default 60; lower it for short test clips)")
    p.add_argument("--username", default="unknown",
                   help="candidate's HackerRank username (for the alert)")
    p.add_argument("--contest-slug", default=None, help="contest slug for the alert id")
    p.add_argument("--video-key", default=None,
                   help="storage object key for the recording (for deep-linking)")
    p.add_argument("--download-url", default=None, dest="download_url_base",
                   help="base download URL of the recording; a #t=<sec> fragment "
                        "is appended at the gap start")
    p.add_argument("--base-offset", type=float, default=0.0,
                   help="wall-clock offset (s) of sampling-time 0 into a longer "
                        "merged recording (default 0)")
    p.add_argument("--api-base", default="http://127.0.0.1:8080",
                   help="proctor backend base url for POST /api/alerts")
    p.add_argument("--api-key", default="", help="x-api-key for /api/alerts ingest")
    p.add_argument("--frames-dir", default=None,
                   help="where to write sampled frames (default a temp dir under "
                        ".data/, removed after run)")
    p.add_argument("--keep-frames", action="store_true",
                   help="keep sampled frames (debug; only with --frames-dir)")
    p.add_argument("--no-post", action="store_true", help="do not POST alerts")
    p.add_argument("--dry-run", action="store_true", help="alias for --no-post")
    p.add_argument("--json", action="store_true",
                   help="print the alerts + summary as JSON to stdout")
    return p


def main(argv=None):
    args = build_argparser().parse_args(argv)
    print(f"[tab-away] imaging backend: {_BACKEND}", file=sys.stderr)

    alerts, summary = analyze_recording(
        args.video, args.logo,
        interval=args.interval, threshold=args.threshold,
        region=parse_region(args.region), min_gap_seconds=args.min_gap_seconds,
        username=args.username, contest_slug=args.contest_slug,
        video_key=args.video_key, download_url_base=args.download_url_base,
        base_offset=args.base_offset, frames_dir=args.frames_dir,
        keep_frames=args.keep_frames,
    )

    print(f"[tab-away] frames={summary['n_frames']} interval={summary['interval']}s "
          f"threshold={summary['threshold']} -> {summary['n_alerts']} tab_away alert(s)",
          file=sys.stderr)

    # client-side validate (mirror backend) before POST
    bad = [(a["id"], validate_alert(a)) for a in alerts]
    bad = [(i, e) for i, e in bad if e]
    if bad:
        print(f"[tab-away] WARNING: {len(bad)} alerts failed validation: {bad[:3]}",
              file=sys.stderr)
        bad_ids = {i for i, _ in bad}
        alerts = [a for a in alerts if a["id"] not in bad_ids]

    posted = None
    if alerts and not (args.no_post or args.dry_run):
        ok, info = post_alerts(args.api_base, args.api_key, alerts)
        posted = {"ok": ok, "info": info}
        print(f"[tab-away] POST {args.api_base}/api/alerts -> ok={ok} info={info}",
              file=sys.stderr)
    elif alerts:
        print("[tab-away] (post skipped: --no-post/--dry-run)", file=sys.stderr)

    if args.json:
        print(json.dumps({"summary": summary, "alerts": alerts, "posted": posted},
                         indent=2))
    else:
        for a in alerts:
            print(f"  {a['id']}  {a['detail']}")

    # exit 0 always on a successful analysis; POST failure is surfaced but not fatal
    # (the recording was analyzed; a transient backend outage shouldn't fail a batch).
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
