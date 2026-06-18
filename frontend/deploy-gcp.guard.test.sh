#!/usr/bin/env bash
# Unit test for the deploy-gcp.sh post-build verification gate.
#
# Proves verify_dist_has_hashes:
#   (a) PASSES (exit 0) when a built dir contains BOTH expected hash strings,
#   (b) ABORTS (nonzero) when EITHER hash is missing.
#
# Uses dummy 64-hex strings — NO real secrets. Runs no gcloud / no deploy.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Sourcing deploy-gcp.sh defines verify_dist_has_hashes and returns early
# (before any gcloud call) because BASH_SOURCE != $0. The required env-var
# asserts run first, so feed them dummy values for the source to succeed.
export PROJECT_ID="test-project"
export API_URL="https://example.invalid"
export ADMIN_PASSWORD="dummy-admin"
export INVIGILATOR_PASSWORD="dummy-invig"
# shellcheck source=./deploy-gcp.sh
source "$SCRIPT_DIR/deploy-gcp.sh"

# deploy-gcp.sh runs `set -euo pipefail`, which the source pulls into this
# shell. Turn off -e so we can observe nonzero returns from the negative cases
# instead of the script aborting on the first expected failure.
set +e

# Dummy 64-char hex strings (NOT real hashes / NOT real secrets).
ADMIN_HASH="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
INVIG_HASH="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

pass=0
fail=0
check() { # <description> <expected_rc> <actual_rc>
  if [ "$2" -eq "$3" ]; then
    echo "PASS: $1 (rc=$3)"
    pass=$((pass + 1))
  else
    echo "FAIL: $1 (expected rc=$2, got rc=$3)"
    fail=$((fail + 1))
  fi
}

# --- (a) both hashes present -> expect exit 0 -------------------------------
dir_both="$(mktemp -d)"
printf 'var a="%s";var b="%s";\n' "$ADMIN_HASH" "$INVIG_HASH" > "$dir_both/index-abc123.js"
verify_dist_has_hashes "$dir_both" "$ADMIN_HASH" "$INVIG_HASH" >/dev/null 2>&1
check "both hashes present -> PASS" 0 $?

# --- (b1) invigilator hash missing -> expect nonzero ------------------------
dir_no_invig="$(mktemp -d)"
printf 'var a="%s";\n' "$ADMIN_HASH" > "$dir_no_invig/index-def456.js"
verify_dist_has_hashes "$dir_no_invig" "$ADMIN_HASH" "$INVIG_HASH" >/dev/null 2>&1
rc=$?; [ "$rc" -ne 0 ] && rc=1 || rc=0
check "invigilator hash missing -> ABORT (nonzero)" 1 $rc

# --- (b2) admin hash missing (the original outage) -> expect nonzero --------
dir_no_admin="$(mktemp -d)"
printf 'var b="%s";\n' "$INVIG_HASH" > "$dir_no_admin/index-ghi789.js"
verify_dist_has_hashes "$dir_no_admin" "$ADMIN_HASH" "$INVIG_HASH" >/dev/null 2>&1
rc=$?; [ "$rc" -ne 0 ] && rc=1 || rc=0
check "admin hash missing -> ABORT (nonzero)" 1 $rc

# --- (b3) both hashes missing -> expect nonzero -----------------------------
dir_empty="$(mktemp -d)"
printf 'var c="no hashes here";\n' > "$dir_empty/index-jkl012.js"
verify_dist_has_hashes "$dir_empty" "$ADMIN_HASH" "$INVIG_HASH" >/dev/null 2>&1
rc=$?; [ "$rc" -ne 0 ] && rc=1 || rc=0
check "both hashes missing -> ABORT (nonzero)" 1 $rc

rm -rf "$dir_both" "$dir_no_invig" "$dir_no_admin" "$dir_empty"

echo "------------------------------------"
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
echo "ALL GUARD TESTS PASSED"
