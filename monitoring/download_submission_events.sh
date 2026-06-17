#!/usr/bin/env bash
# download_submission_events.sh — STEP 1 of 2 (DOWNLOAD).
#
# Thin wrapper around poller.py that PRODUCES the contest's submission metadata
# (meta.json) and immediately SNAPSHOTS it to a safe path for the upload step.
#
# WHAT IT DOES
# ------------
#   1. Runs ONE poller cycle (--once --no-post) so the LiveAcquirer drives the
#      already-running, authenticated Chromium on :9222 over CDP, fetches the
#      contest's leaderboard + judge_submissions, and writes the renamed meta
#      dict to <data-dir>/live/results/meta.json (acquire.LiveAcquirer
#      _write_result). --no-post means NO alerts are emitted — we only want the
#      meta.json side-effect.
#   2. SNAPSHOTS that meta.json to --out IMMEDIATELY. The default meta.json path
#      is OVERWRITTEN every cycle (and by every other contest's poll), so you
#      MUST capture it before anything clobbers it. The snapshot path is what you
#      feed to upload_submission_events.sh.
#      NOTE: the snapshot is race-free ONLY if the chosen --data-dir is PRIVATE to
#      this invocation. The default monitoring/.data is the SAME dir a live poller
#      writes to, so if a live poller (or a second download) runs concurrently it
#      can clobber meta.json between the cycle and the snapshot. For a guaranteed
#      isolated capture, pass a unique --data-dir (e.g. a fresh mktemp -d).
#
# OFFLINE ALTERNATIVE
# -------------------
#   --fixtures <slotDir> reads a committed contest-eval run dir (data/raw/
#   contest_<id>_meta.json) with NO browser and NO network. Use it for replay /
#   validation. In fixtures mode the poller derives the slug from the meta, so
#   --slug/--contest-id are not required (though --contest-id disambiguates a dir
#   holding multiple contests).
#
# PRECONDITIONS (live mode)
# -------------------------
#   * Chromium MUST be running with --remote-debugging-port=9222 AND have a tab
#     logged in as a HackerRank MODERATOR for the contest (so the same-origin
#     credentialed fetch carries the session cookies). If :9222 is down or the
#     tab never reaches the hackerrank.com origin, the poller falls back to
#     fixtures / reports the cycle unavailable and NO meta.json is produced.
#
# RATE-LIMIT NOTE (baked in)
# --------------------------
#   If the poller logs HTTP 429 or an empty leaderboard, the HR API is throttling
#   you. WAIT (tens of seconds to a couple of minutes) and re-run this script
#   with --once again. Do NOT tight-loop — hammering :9222 only deepens the 429.
#
# Usage:
#   monitoring/download_submission_events.sh --slug <SLUG> --contest-id <ID> \
#       [--data-dir <DIR>] [--out <PATH>] [--devtools-url <URL>]
#   monitoring/download_submission_events.sh --fixtures <slotDir> \
#       [--contest-id <ID>] [--data-dir <DIR>] [--out <PATH>]
#
#   --slug         contest slug (live mode; required unless --fixtures)
#   --contest-id   HackerRank numeric contest id (live: recommended; fixtures:
#                  optional disambiguator)
#   --fixtures     OFFLINE slot dir with data/raw/contest_<id>_meta.json
#   --data-dir     poller PII output dir (default: monitoring/.data) — the live
#                  meta lands at <data-dir>/live/results/meta.json
#   --out          snapshot destination (default: /tmp/<slug-or-fixtures>-meta-<unix>.json)
#   --devtools-url Chrome DevTools base url (default http://127.0.0.1:9222)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLLER="${HERE}/poller.py"

SLUG=""
CONTEST_ID=""
FIXTURES=""
DATA_DIR="${HERE}/.data"
OUT=""
DEVTOOLS_URL=""

usage() {
  sed -n '2,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() { echo "ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)         SLUG="${2:?--slug needs a value}"; shift 2 ;;
    --contest-id)   CONTEST_ID="${2:?--contest-id needs a value}"; shift 2 ;;
    --fixtures)     FIXTURES="${2:?--fixtures needs a value}"; shift 2 ;;
    --data-dir)     DATA_DIR="${2:?--data-dir needs a value}"; shift 2 ;;
    --out)          OUT="${2:?--out needs a value}"; shift 2 ;;
    --devtools-url) DEVTOOLS_URL="${2:?--devtools-url needs a value}"; shift 2 ;;
    -h|--help)      usage 0 ;;
    *)              echo "ERROR: unknown arg: $1" >&2; usage 1 ;;
  esac
done

[[ -f "${POLLER}" ]] || die "poller.py not found at ${POLLER}"

# Validate the mode: fixtures (offline) XOR live (--slug). --contest-id alone is
# not enough for live mode (the poller requires --slug when --fixtures is absent).
if [[ -n "${FIXTURES}" ]]; then
  [[ -d "${FIXTURES}" ]] || die "--fixtures dir not found: ${FIXTURES}"
  MODE="fixtures"
  LABEL="$(basename "${FIXTURES}")"
else
  [[ -n "${SLUG}" ]] || die "live mode needs --slug (or pass --fixtures <slotDir> for offline)"
  MODE="live"
  LABEL="${SLUG}"
fi

# Default snapshot path: /tmp/<label>-meta-<unix-ts>.json
TS="$(date +%s)"
if [[ -z "${OUT}" ]]; then
  OUT="/tmp/${LABEL}-meta-${TS}.json"
fi

# The poller's LiveAcquirer/FixturesAcquirer both write the renamed meta dict to
# <data-dir>/live/results/meta.json (acquire.LiveAcquirer._write_result). This is
# also post_submission_events.py DEFAULT_META.
META_PATH="${DATA_DIR}/live/results/meta.json"

# Build the poller invocation.
#   --once     single cycle, then exit
#   --no-post  do NOT emit alerts (we only want the meta.json side-effect)
#   --no-enrich  skip the admin/sessions name+room lookups — irrelevant to a pure
#                meta download, and avoids needless load on the live backend
CMD=(python3 "${POLLER}" --once --no-post --no-enrich --data-dir "${DATA_DIR}")
if [[ "${MODE}" == "fixtures" ]]; then
  CMD+=(--fixtures "${FIXTURES}")
  [[ -n "${CONTEST_ID}" ]] && CMD+=(--contest-id "${CONTEST_ID}")
  [[ -n "${SLUG}" ]] && CMD+=(--slug "${SLUG}")
else
  CMD+=(--slug "${SLUG}")
  [[ -n "${CONTEST_ID}" ]] && CMD+=(--contest-id "${CONTEST_ID}")
  [[ -n "${DEVTOOLS_URL}" ]] && CMD+=(--devtools-url "${DEVTOOLS_URL}")
fi

echo "==> DOWNLOAD submission-events meta (step 1 of 2)"
echo "    mode      : ${MODE}"
echo "    label     : ${LABEL}"
echo "    data-dir  : ${DATA_DIR}"
echo "    meta path : ${META_PATH}  (OVERWRITTEN every cycle — snapshotting below)"
echo "    snapshot  : ${OUT}"
if [[ "${MODE}" == "live" ]]; then
  echo
  echo "    PRECONDITION: Chromium must be on :9222 with a logged-in HackerRank-"
  echo "    moderator tab for this contest. If :9222 is down or the HR session"
  echo "    expired, no meta.json will be produced."
fi
echo
echo "==> running:"
printf '    %q ' "${CMD[@]}"; echo
echo

# Run the poller cycle. We do NOT abort the script on a non-zero poller exit here
# (a 'metadata-unavailable' cycle returns 1); instead we check for a fresh
# meta.json below and report a clear, actionable message.
set +e
"${CMD[@]}"
POLLER_RC=$?
set -e
echo
echo "==> poller exited rc=${POLLER_RC}"

if [[ ! -f "${META_PATH}" ]]; then
  die "no meta.json at ${META_PATH} after the cycle.
  Live: confirm Chromium is on :9222 with a logged-in HackerRank-moderator tab,
  then re-run. If the log showed HTTP 429 / an empty leaderboard, WAIT and re-run
  --once (do NOT tight-loop)."
fi

# SNAPSHOT IMMEDIATELY — before any other contest poll clobbers the shared
# default meta.json.
mkdir -p "$(dirname "${OUT}")"
cp "${META_PATH}" "${OUT}"

# Surface the submission count so the operator can sanity-check before uploading.
N_SUBS="$(python3 - "${OUT}" <<'PY'
import json, sys
try:
    m = json.load(open(sys.argv[1]))
    print(len(m.get("submissions") or []))
except Exception:
    print("?")
PY
)"

echo
echo "==> SNAPSHOT WRITTEN: ${OUT}"
echo "    submissions in snapshot: ${N_SUBS}"
if [[ "${N_SUBS}" == "0" ]]; then
  echo
  echo "    WARNING: 0 submissions. The leaderboard/judge_submissions may be empty"
  echo "    or you hit a 429. WAIT and re-run --once (do NOT tight-loop)."
fi
echo
echo "==> NEXT (step 2 of 2): upload this snapshot:"
echo "    monitoring/upload_submission_events.sh \\"
echo "        --meta ${OUT} \\"
echo "        --contest-slug <SLUG-MATCHING-PROCTOR-SESSIONS> \\"
echo "        --api-base <BACKEND_URL>"
