#!/usr/bin/env python3
"""test_tab_away — SELF-CONTAINED test for the LOCAL tab-away detector.

Needs NO real recording and NO real HackerRank logo crop. It synthesizes, with
ffmpeg only:
  * a tiny "logo" crop PNG (a colored rectangle on a contrasting background), and
  * a short screen-capture-like .webm whose top-left corner shows that same logo
    for the first/last thirds and is BLANK (logo absent) in the middle third.

Then it runs the detector end-to-end (frame sample -> numpy/cv2 template match ->
gap detect -> alert build, NO network POST) and asserts:
  1. the detector flags exactly the middle (no-logo) span as a `tab_away` alert,
  2. the alert obeys the shared contract (source/type/severity + required fields,
     idempotent id, video_key + #t deep-link), and
  3. the gap offsets line up with where the logo actually disappeared.

The production rule is ">60s continuous"; the synthetic clip is only seconds
long, so the test passes `--min-gap-seconds` low (the SAME knob exposed on the
CLI). The >60s default is unchanged in production.

Run:   python3 monitoring/test_tab_away.py
Exit:  0 iff all asserts pass; nonzero on the first failure or if ffmpeg/imaging
       backend is missing (a SKIP-with-failure rather than a silent pass).
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import tab_away_detector as tad


PASS = 0
FAIL = 0


def check(cond, name, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}" + (f"\n        {detail}" if detail else ""))


def have(bin_):
    return shutil.which(bin_) is not None


# ---------------------------------------------------------------------------
# synthesize the logo crop + the 3-segment clip with ffmpeg
# ---------------------------------------------------------------------------
# A synthetic "logo": a white outer box with a black inner box (so the crop has
# INTERNAL STRUCTURE / variance — a flat color crop has zero NCC norm and can't
# match). Sized to sit comfortably INSIDE the top-left search region. This mirrors
# the real constraint: the canonical HR-logo crop must (a) have contrast and (b)
# fit within --region. The same ffmpeg filter draws it onto the PRESENT frames.
_LOGO_FILTER = ("drawbox=x=10:y=8:w=60:h=20:color=white:t=fill,"
                "drawbox=x=25:y=13:w=30:h=10:color=black:t=fill")


def make_clip_and_logo(clip_path, logo_path, ffmpeg, seg=6, w=640, h=360):
    """Build a `3*seg`-second clip (PRESENT / ABSENT / PRESENT) AND derive the
    logo crop straight out of a PRESENT frame — exactly the real workflow of
    snipping the HackerRank logo out of an actual recording frame.

    Returns seg (segment length in seconds).
    """
    tmp = Path(tempfile.mkdtemp(prefix="clipsrc-"))
    try:
        # PRESENT: gray "desktop" + the structured logo in the top-left corner.
        present = tmp / "present.webm"
        subprocess.run([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"color=c=gray:s={w}x{h}:d={seg}",
            "-vf", _LOGO_FILTER,
            "-r", "10", "-pix_fmt", "yuv420p", str(present),
        ], check=True, capture_output=True, text=True)

        # Derive the canonical logo crop from a single PRESENT frame (90x36 @ 0,0).
        subprocess.run([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(present), "-vf", "crop=90:36:0:0",
            "-frames:v", "1", str(logo_path),
        ], check=True, capture_output=True, text=True)

        # ABSENT: identical gray desktop, NO logo in the corner.
        absent = tmp / "absent.webm"
        subprocess.run([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"color=c=gray:s={w}x{h}:d={seg}",
            "-r", "10", "-pix_fmt", "yuv420p", str(absent),
        ], check=True, capture_output=True, text=True)

        path = clip_path

        listf = tmp / "list.txt"
        listf.write_text(
            f"file '{present}'\nfile '{absent}'\nfile '{present}'\n")
        subprocess.run([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "concat", "-safe", "0", "-i", str(listf),
            "-c", "copy", str(path),
        ], check=True, capture_output=True, text=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return seg


def make_present_only(path, ffmpeg, dur=8, w=640, h=360):
    """A logo-present-throughout clip for the negative control."""
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"color=c=gray:s={w}x{h}:d={dur}",
        "-vf", _LOGO_FILTER, "-r", "10", "-pix_fmt", "yuv420p", str(path),
    ], check=True, capture_output=True, text=True)


def main():
    print("=" * 70)
    print("tab-away detector self-test (synthetic clip, no real sample needed)")
    print("=" * 70)

    ffmpeg = "ffmpeg"
    if not have(ffmpeg):
        print("  FAIL  ffmpeg is required for the synthetic self-test but is not on PATH")
        return 1
    if tad.backend_name() == "stub":
        print("  FAIL  no imaging backend (cv2 or numpy+Pillow) -> cannot match; "
              "install numpy+pillow or opencv-python")
        return 1
    print(f"  imaging backend under test: {tad.backend_name()}")

    work = Path(tempfile.mkdtemp(prefix="tabaway-test-"))
    try:
        logo = work / "logo.png"
        clip = work / "clip.webm"
        seg = make_clip_and_logo(clip, logo, ffmpeg)

        interval = 2.0  # sample every 2s -> 3 frames per 6s segment
        # min-gap below the 6s absent span so the synthetic gap fires; the SAME
        # knob the CLI exposes (--min-gap-seconds). Production default stays 60.
        min_gap = 3.0

        alerts, summary = tad.analyze_recording(
            clip, logo,
            interval=interval, threshold=0.5,
            region=tad.parse_region("top-left"),
            min_gap_seconds=min_gap,
            username="TestUser", contest_slug="synthetic-contest",
            video_key="screen/test-session/clip.webm",
            download_url_base="https://example.test/clip.webm",
            frames_dir=str(work / "frames"), keep_frames=False,
        )

        print(f"  scores per {interval}s frame: {summary['scores']}")
        print(f"  runs={summary['n_runs']} alerts={summary['n_alerts']}")

        # 1. exactly one tab_away alert (the middle blank segment)
        check(len(alerts) == 1,
              "exactly one tab_away alert for the single no-logo span",
              detail=f"got {len(alerts)} (scores={summary['scores']})")
        if not alerts:
            return 1
        a = alerts[0]

        # 2. shared contract: source/type/severity + required fields present
        check(a["source"] == "proctor", "alert.source == 'proctor'", detail=str(a["source"]))
        check(a["type"] == "tab_away", "alert.type == 'tab_away'", detail=str(a["type"]))
        check(a["severity"] == "warning", "alert.severity == 'warning'", detail=str(a["severity"]))
        from alerts import validate_alert
        err = validate_alert(a)
        check(err is None, "alert passes the shared-contract validator", detail=str(err))

        # id format: proctor:tab_away:<user>:<slug>:<dedupe> (5 colon segments)
        parts = a["id"].split(":")
        check(len(parts) == 5 and parts[0] == "proctor" and parts[1] == "tab_away",
              "id == proctor:tab_away:<user>:<slug>:<dedupe>", detail=a["id"])

        # 3. gap offsets line up with the middle segment [seg .. 2*seg]
        start = a["data"]["start_offset"]
        end = a["data"]["end_offset"]
        # the absent span starts at ~seg seconds and ends at ~2*seg seconds; allow
        # one interval of slack for frame-sampling alignment.
        check(abs(start - seg) <= interval,
              f"gap start ~{seg}s (where the logo vanished)", detail=f"start={start}")
        check(abs(end - 2 * seg) <= interval + 0.001,
              f"gap end ~{2*seg}s (where the logo returned)", detail=f"end={end}")
        check(a["data"]["duration_seconds"] > min_gap,
              f"flagged gap duration > min_gap ({min_gap}s)",
              detail=str(a["data"]["duration_seconds"]))

        # 4. deep-link convention: #t=<seconds> fragment + video_key carried
        check(a.get("video_key") == "screen/test-session/clip.webm",
              "video_key carries the recording object key", detail=str(a.get("video_key")))
        frag = a["data"]["deep_link_fragment"]
        check(frag == f"#t={int(round(start))}",
              "data.deep_link_fragment is #t=<gap-start-seconds>", detail=frag)
        check(a.get("download_url", "").endswith(frag),
              "download_url deep-links to the gap start via #t=", detail=str(a.get("download_url")))

        # 5. NEGATIVE control: a present-logo-only clip must flag NOTHING.
        #    (re-run the detector over only the PRESENT segments -> zero alerts.)
        present_only = work / "present_only.webm"
        make_present_only(present_only, ffmpeg)
        neg_alerts, neg_sum = tad.analyze_recording(
            present_only, logo, interval=interval, threshold=0.5,
            region=tad.parse_region("top-left"), min_gap_seconds=min_gap,
            username="TestUser", contest_slug="synthetic-contest",
            video_key="k", download_url_base=None,
            frames_dir=str(work / "frames2"), keep_frames=False,
        )
        check(len(neg_alerts) == 0,
              "negative control: logo-present-throughout clip flags NOTHING",
              detail=f"got {len(neg_alerts)} (scores={neg_sum['scores']})")

    finally:
        shutil.rmtree(work, ignore_errors=True)

    print("\n" + "=" * 70)
    total = PASS + FAIL
    print(f"RESULT: {PASS}/{total} passed, {FAIL} failed")
    print("=" * 70)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
