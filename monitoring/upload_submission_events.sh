#!/usr/bin/env bash
# upload_submission_events.sh — STEP 2 of 2 (UPLOAD).
#
# Thin wrapper over post_submission_events.py that POSTs the submission-time
# markers (one GREEN/RED marker per code submission) from a snapshotted meta.json
# to <api-base>/api/submission-events. The backend keys docs by
# username_norm:contest_slug and de-dups by submission_id, so this is idempotent.
#
# This wrapper BAKES IN the gotchas the raw script can't enforce on its own:
#
#   1. DRY-RUN FIRST, ALWAYS. We run post_submission_events.py --dry-run to
#      classify valid/invalid/skipped and print counts WITHOUT posting. Unless
#      --yes is passed, you must confirm before the real POST runs.
#
#   2. --contest-slug MUST EQUAL the proctor sessions' contest_slug. The backend
#      stores markers under username_norm:contest_slug, and the admin
#      recording-review timeline reads them back by that SAME slug. A mismatched
#      slug silently writes markers the UI will NEVER show. There is no error —
#      just an empty timeline. Double-check the slug against the sessions.
#
#   3. API-KEY SOURCING (never hardcoded/committed). If you don't pass --api-key,
#      we try to read it from a RUNNING poller's args (pgrep -af poller.py,
#      extract the --api-key value). If no poller is running, fetch the backend
#      env ALERTS_INGEST_API_KEY yourself and pass it via --api-key. The key
#      equals the backend's ALERTS_INGEST_API_KEY (x-api-key requireApiKey gate).
#
#   4. IDEMPOTENT RE-RUN on failure. The uploader has NO retry. On a transient
#      503 / network error, just RE-RUN this exact command — the backend upsert
#      de-dups by submission_id (merge), so re-runs never duplicate. Keep --batch
#      at or below 500 (a real run posted 6549 events in 14 batches of 500).
#
# Usage:
#   monitoring/upload_submission_events.sh --meta <PATH> --contest-slug <SLUG> \
#       --api-base <BACKEND_URL> [--api-key <KEY>] [--batch 500] [--yes]
#
#   --meta         snapshotted meta.json from download_submission_events.sh (REQUIRED)
#   --contest-slug MUST match the proctor sessions' contest_slug (REQUIRED)
#   --api-base     proctor backend base url (REQUIRED)
#   --api-key      x-api-key == backend ALERTS_INGEST_API_KEY. If omitted, sourced
#                  from a running poller's args; else you must provide it.
#   --batch        events per POST (default 500; keep <= 500)
#   --yes          skip the confirm prompt after the dry-run (non-interactive)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POSTER="${HERE}/post_submission_events.py"

META=""
CONTEST_SLUG=""
API_BASE=""
API_KEY=""
BATCH="500"
ASSUME_YES="0"

usage() {
  sed -n '2,52p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() { echo "ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --meta)         META="${2:?--meta needs a value}"; shift 2 ;;
    --contest-slug) CONTEST_SLUG="${2:?--contest-slug needs a value}"; shift 2 ;;
    --api-base)     API_BASE="${2:?--api-base needs a value}"; shift 2 ;;
    --api-key)      API_KEY="${2:?--api-key needs a value}"; shift 2 ;;
    --batch)        BATCH="${2:?--batch needs a value}"; shift 2 ;;
    --yes|-y)       ASSUME_YES="1"; shift ;;
    -h|--help)      usage 0 ;;
    *)              echo "ERROR: unknown arg: $1" >&2; usage 1 ;;
  esac
done

[[ -f "${POSTER}" ]]      || die "post_submission_events.py not found at ${POSTER}"
[[ -n "${META}" ]]        || die "--meta is required (the snapshot from download_submission_events.sh)"
[[ -f "${META}" ]]        || die "--meta file not found: ${META}"
[[ -n "${CONTEST_SLUG}" ]] || die "--contest-slug is required (MUST match the proctor sessions' contest_slug)"
[[ -n "${API_BASE}" ]]    || die "--api-base is required (proctor backend base url)"

# Keep --batch sane: integer, and capped at 500 (the proven-safe chunk size; a
# real run posted 6549 events in 14 batches of 500). post_submission_events.py
# does its own chunking, so this is just an extra guard.
[[ "${BATCH}" =~ ^[0-9]+$ ]] || die "--batch must be an integer (got: ${BATCH})"
if [[ "${BATCH}" -gt 500 ]]; then
  echo "WARNING: --batch ${BATCH} > 500; clamping to 500 (proven safe chunk size)." >&2
  BATCH="500"
fi
[[ "${BATCH}" -ge 1 ]] || die "--batch must be >= 1"

# ---- API key sourcing (NEVER hardcode/commit) ----
KEY_SOURCE="--api-key (explicit)"
if [[ -z "${API_KEY}" ]]; then
  # Try to lift it from a running poller's command line.
  POLLER_LINE="$(pgrep -af 'poller\.py' 2>/dev/null | grep -- '--api-key' | head -n1 || true)"
  if [[ -n "${POLLER_LINE}" ]]; then
    # Extract the token following --api-key (handles "--api-key VALUE").
    API_KEY="$(printf '%s\n' "${POLLER_LINE}" | sed -n 's/.*--api-key[ =]\{1,\}\([^ ]*\).*/\1/p' | head -n1)"
    [[ -n "${API_KEY}" ]] && KEY_SOURCE="running poller (pgrep -af poller.py)"
  fi
fi
if [[ -z "${API_KEY}" ]]; then
  die "no --api-key, and could not read one from a running poller.
  Fetch the backend env ALERTS_INGEST_API_KEY and pass it:
      --api-key \"\$ALERTS_INGEST_API_KEY\"
  (x-api-key must equal the backend's ALERTS_INGEST_API_KEY; never hardcode/commit it.)"
fi

# Common args for both the dry-run and the real POST. The api-key is passed but
# NEVER echoed.
COMMON=(python3 "${POSTER}"
  --meta "${META}"
  --contest-slug "${CONTEST_SLUG}"
  --api-base "${API_BASE}"
  --batch "${BATCH}")

echo "==> UPLOAD submission-events (step 2 of 2)"
echo "    meta         : ${META}"
echo "    contest-slug : ${CONTEST_SLUG}  (MUST match the proctor sessions' slug)"
echo "    api-base     : ${API_BASE}"
echo "    api-key      : <hidden> (from ${KEY_SOURCE})"
echo "    batch        : ${BATCH}"
echo
echo "    REMINDER: if --contest-slug does NOT match the proctor sessions, the"
echo "    markers store fine but the recording-review timeline shows NOTHING."
echo

# ---- 1) DRY-RUN ALWAYS (classify + counts, no POST) ----
echo "==> dry-run (classify valid/invalid/skipped; no POST):"
printf '    %q ' "${COMMON[@]}" "--api-key" "<hidden>" "--dry-run"; echo
echo
"${COMMON[@]}" --api-key "${API_KEY}" --dry-run
echo

# ---- 2) Confirm before the real POST (unless --yes) ----
if [[ "${ASSUME_YES}" != "1" ]]; then
  if [[ ! -t 0 ]]; then
    die "not a TTY and --yes was not passed; refusing to POST without confirmation.
  Re-run with --yes to POST non-interactively."
  fi
  printf 'Proceed with the REAL POST to %s/api/submission-events? [y/N] ' "${API_BASE}"
  read -r ANSWER
  case "${ANSWER}" in
    y|Y|yes|YES) ;;
    *) echo "Aborted by operator. Nothing was posted."; exit 0 ;;
  esac
fi

# ---- 3) REAL POST (re-run the same command WITHOUT --dry-run) ----
echo
echo "==> POSTING for real:"
printf '    %q ' "${COMMON[@]}" "--api-key" "<hidden>"; echo
echo
"${COMMON[@]}" --api-key "${API_KEY}"
echo
echo "==> UPLOAD DONE."
echo "    On a transient 503 / network error, RE-RUN this exact command — the"
echo "    backend upsert de-dups by submission_id, so re-runs never duplicate."
