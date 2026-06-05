#!/usr/bin/env bash
# run-demo.sh — single, self-contained, FIXTURES end-to-end demo of the
# contest-eval monitoring loop:
#
#   poller (--fixtures --once) --> POST /api/alerts (x-api-key) --> in-memory
#   backend --> GET /api/admin/alerts (x-admin-password) --> print ingested alerts
#
# Offline: no browser, no :9222, no GCP, no Firestore. Uses monitoring/
# mock_alert_server.py as a stdlib stand-in for the proctor backend's two alert
# routes (the real backend needs Firestore; see night-run/HOW-TO-RUN.md for the
# real functions-framework path on a GCP-capable machine).
#
# Idempotent + self-cleaning: kills the background server on exit (any path).
#
# Usage:  bash monitoring/run-demo.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${DEMO_PORT:-8799}"
API_KEY="demo-ingest-key-not-a-secret"
ADMIN_PW="demo-admin"
API_BASE="http://127.0.0.1:${PORT}"

FIX_BASE="/home/karthi/arogara/contest-eval/MCET-06-26"
SLOT_DIR="${FIX_BASE}/386521-slot1"
CONTEST_ID="386521"
SLUG="coding-contest-mcet-june-2026"
DATA_DIR="${HERE}/.data/demo"

SERVER_PID=""
cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "==> contest-eval monitoring — FIXTURES end-to-end demo"
echo "    slot=${SLOT_DIR}"
echo "    backend=${API_BASE} (in-memory mock; real path uses functions-framework + Firestore)"

if [[ ! -f "${SLOT_DIR}/data/raw/contest_${CONTEST_ID}_meta.json" ]]; then
  echo "ERROR: fixtures not found at ${SLOT_DIR}/data/raw/ — check out the MCET fixtures." >&2
  exit 1
fi

# Free a stale server on the port from a previous aborted run (idempotency).
if command -v lsof >/dev/null 2>&1; then
  STALE="$(lsof -ti tcp:"${PORT}" 2>/dev/null || true)"
  if [[ -n "${STALE}" ]]; then
    echo "==> freeing stale listener on :${PORT} (pid ${STALE})"
    kill "${STALE}" 2>/dev/null || true
    sleep 0.5
  fi
fi

rm -rf "${DATA_DIR}"
mkdir -p "${DATA_DIR}"

echo "==> starting mock backend on :${PORT}"
ALERTS_INGEST_API_KEY="${API_KEY}" ADMIN_PASSWORD="${ADMIN_PW}" \
  python3 "${HERE}/mock_alert_server.py" --port "${PORT}" &
SERVER_PID=$!

# Wait for the server to accept connections (max ~5s).
for _ in $(seq 1 50); do
  if curl -fsS "${API_BASE}/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
if ! curl -fsS "${API_BASE}/healthz" >/dev/null 2>&1; then
  echo "ERROR: mock backend did not come up on :${PORT}" >&2
  exit 1
fi
echo "    backend up."

echo "==> running poller --fixtures --once (POSTs alerts to the backend)"
python3 "${HERE}/poller.py" \
  --fixtures "${SLOT_DIR}" \
  --contest-id "${CONTEST_ID}" \
  --slug "${SLUG}" \
  --once \
  --api-base "${API_BASE}" \
  --api-key "${API_KEY}" \
  --data-dir "${DATA_DIR}" \
  --verdict-queue "${DATA_DIR}/verdict-queue"

echo "==> GET /api/admin/alerts (x-admin-password) — ingested alerts:"
RESP="$(curl -fsS "${API_BASE}/api/admin/alerts" -H "x-admin-password: ${ADMIN_PW}")"

# Pretty summary + a few sample alerts (no jq dependency).
python3 - "$RESP" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
alerts = data.get("alerts", [])
print(f"    total alerts in backend: {len(alerts)}")
by_type = {}
by_sev = {}
for a in alerts:
    by_type[a.get("type")] = by_type.get(a.get("type"), 0) + 1
    by_sev[a.get("severity")] = by_sev.get(a.get("severity"), 0) + 1
print(f"    by type:     {by_type}")
print(f"    by severity: {by_sev}")
print("    sample (first 3):")
for a in alerts[:3]:
    print(f"      - [{a.get('severity')}] {a.get('type')}: {a.get('title')}")
    print(f"        id={a.get('id')}")
# the demo fails loudly if nothing was ingested
if not alerts:
    print("ERROR: backend returned zero alerts — ingest loop is broken", file=sys.stderr)
    sys.exit(1)
PY

echo "==> re-running the poller once more to prove IDEMPOTENT merge (no duplicates)"
python3 "${HERE}/poller.py" \
  --fixtures "${SLOT_DIR}" --contest-id "${CONTEST_ID}" --slug "${SLUG}" --once \
  --api-base "${API_BASE}" --api-key "${API_KEY}" \
  --data-dir "${DATA_DIR}" --verdict-queue "${DATA_DIR}/verdict-queue" >/dev/null
RESP2="$(curl -fsS "${API_BASE}/api/admin/alerts" -H "x-admin-password: ${ADMIN_PW}")"
python3 - "$RESP" "$RESP2" <<'PY'
import json, sys
n1 = len(json.loads(sys.argv[1]).get("alerts", []))
n2 = len(json.loads(sys.argv[2]).get("alerts", []))
print(f"    after 1st poll: {n1} alerts ; after 2nd poll: {n2} alerts")
if n1 != n2:
    print(f"ERROR: idempotency broken — count changed {n1} -> {n2}", file=sys.stderr)
    sys.exit(1)
print("    idempotent: re-poll merged onto the same ids (no duplicates).")
PY

echo "==> wrong x-admin-password must be rejected (401):"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "${API_BASE}/api/admin/alerts" -H 'x-admin-password: nope')"
echo "    GET /api/admin/alerts with wrong password -> HTTP ${CODE}"
[[ "${CODE}" == "401" ]] || { echo "ERROR: expected 401 for bad admin password" >&2; exit 1; }

echo "==> DEMO OK — poller -> ingest -> admin read loop is green. Cleaning up."
# cleanup() runs on EXIT (kills the bg server).
