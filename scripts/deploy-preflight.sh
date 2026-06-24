#!/usr/bin/env bash
# scripts/deploy-preflight.sh — the MANDATORY live-activity check before ANY deploy.
#
# WHY: proctor-api / proctor-web serve the LIVE test. Redeploying either while a
# test is in progress (or an invigilator/admin is actively using the console) can
# interrupt candidates mid-exam. proctor-eval is the ONLY service that is safe to
# deploy at any time — it shares Firestore/GCS but has no test-taking dependency,
# so a bad eval deploy can never touch an in-progress exam.
#
# This script queries the live session counts (GET /api/admin/stats on proctor-api)
# and prints a clear SAFE / NOT-SAFE verdict per service. It NEVER deploys — it is
# advisory + a hard gate the operator (or an agent) must read first.
#
# Usage:
#   scripts/deploy-preflight.sh            # checks across all contests
#   scripts/deploy-preflight.sh <slug>     # scope to one contest
#
# Reads ADMIN_PASSWORD from .env.deploy.local (mode 600, never echoed). Resolves
# the proctor-api URL via gcloud. Exit code: 0 = no live sessions (eval+api+web
# all clear); 10 = live sessions present (api/web deploy requires explicit
# override; eval still safe).
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${REGION:-asia-south1}"
SLUG="${1:-}"
GCLOUD="${GCLOUD:-$HOME/google-cloud-sdk/bin/gcloud}"

if [ ! -f .env.deploy.local ]; then echo "✗ .env.deploy.local not found (need ADMIN_PASSWORD)"; exit 2; fi
ADMINPW="$(grep -E '^ADMIN_PASSWORD=' .env.deploy.local | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
if [ -z "$ADMINPW" ]; then echo "✗ ADMIN_PASSWORD missing from .env.deploy.local"; exit 2; fi

# Resolve the project from $PROJECT, then $PROJECT_ID (what the deploy scripts and
# .env.deploy.local actually set), then PROJECT_ID read from .env.deploy.local, then
# a placeholder. This removes the footgun of needing a separate `export PROJECT=...`
# before a deploy — the frontend deploy invokes this preflight with PROJECT_ID set,
# and a standalone run picks PROJECT_ID up straight from the deploy env file.
ENV_PROJECT_ID="$(grep -E '^PROJECT_ID=' .env.deploy.local | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
PROJECT="${PROJECT:-${PROJECT_ID:-${ENV_PROJECT_ID:-your-gcp-project-id}}}"

API_URL="$("$GCLOUD" run services describe proctor-api --region "$REGION" --project "$PROJECT" --format='value(status.url)' 2>/dev/null || true)"
if [ -z "$API_URL" ]; then echo "✗ could not resolve proctor-api URL (gcloud auth?)"; exit 2; fi

QS=""
[ -n "$SLUG" ] && QS="?contest_slug=$SLUG"
STATS="$(curl -s -H "x-admin-password: $ADMINPW" "$API_URL/api/admin/stats$QS" || true)"

read -r LIVE DISC TOTAL <<EOF
$(printf '%s' "$STATS" | python3 -c "import sys,json;d=json.load(sys.stdin).get('stats',{});print(d.get('live',0),d.get('disconnected',0),d.get('total',0))" 2>/dev/null || echo "ERR ERR ERR")
EOF

# FRESH live = active AND recently-heartbeating (live minus the stale/disconnected
# ones). A real in-progress test shows fresh > 0; leftover never-ended sessions
# show up as live==disconnected (stale) and are almost certainly not a live exam.
FRESH="ERR"
if [ "$LIVE" != "ERR" ]; then FRESH=$(( ${LIVE:-0} - ${DISC:-0} )); [ "$FRESH" -lt 0 ] && FRESH=0; fi

echo "── Deploy preflight ───────────────────────────────────"
echo "  contest scope : ${SLUG:-ALL contests}"
echo "  live sessions : ${LIVE}   (fresh/heartbeating: ${FRESH} · stale: ${DISC} · total docs: ${TOTAL})"
echo "───────────────────────────────────────────────────────"
if [ "$LIVE" = "ERR" ]; then
  echo "  ⚠️  could not read /api/admin/stats — TREAT AS UNSAFE for proctor-api/web until confirmed."
  echo "      proctor-eval is still safe to deploy."
  exit 10
fi
if [ "${FRESH:-0}" -gt 0 ] 2>/dev/null; then
  echo "  🔴 A TEST IS LIVE NOW (${FRESH} actively-heartbeating session(s))."
  echo "     • proctor-eval  → SAFE to deploy (no test-taking dependency)."
  echo "     • proctor-api   → UNSAFE. Do NOT deploy during a live test."
  echo "     • proctor-web   → UNSAFE. Do NOT deploy during a live test."
  echo "     An agent MUST NOT deploy proctor-api/proctor-web here without an EXPLICIT"
  echo "     human override, and even then ONLY via the staged zero-downtime flow"
  echo "     (--no-traffic --tag → verify the tagged revision → update-traffic), with"
  echo "     the prior revision held at 0% for instant rollback."
  exit 10
fi
if [ "${LIVE:-0}" -gt 0 ] 2>/dev/null; then
  echo "  🟡 ${LIVE} session(s) marked active but ALL are stale/disconnected — likely leftover,"
  echo "     not a live exam. proctor-eval is SAFE. Before deploying proctor-api/proctor-web,"
  echo "     CONFIRM with the operator that no test is starting and there's no active console use."
  exit 10
fi
echo "  🟢 No live sessions detected — all three services are safe to deploy"
echo "     (still use the staged --no-traffic --tag flow for api/web)."
exit 0
