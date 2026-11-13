#!/usr/bin/env bash
# Phase 2 end-to-end check: break the demo system, wait for Firstlook's triage note, print it.
#   ./scripts/e2e.sh [scenario] [timeout-seconds]
set -euo pipefail

SCENARIO="${1:-bad-deploy}"
TIMEOUT="${2:-360}"
API="${API_URL:-http://localhost:8081}"
AGENT="${AGENT_URL:-http://localhost:8080}"
TOKEN="${ADMIN_TOKEN:-dev-admin-token}"

before="$(curl -fsS -m 10 "$AGENT/api/incidents?limit=1" | python3 -c 'import json,sys; d=json.load(sys.stdin)["incidents"]; print(d[0]["id"] if d else "")')"
echo "→ starting scenario: $SCENARIO"
curl -fsS -m 10 -X POST -H "x-admin-token: $TOKEN" "$API/admin/scenarios/$SCENARIO/start" >/dev/null
trap 'curl -fsS -m 10 -X POST -H "x-admin-token: $TOKEN" "$API/admin/scenarios/$SCENARIO/stop" >/dev/null || true' EXIT

deadline=$(( $(date +%s) + TIMEOUT ))
while (( $(date +%s) < deadline )); do
  id="$(curl -fsS -m 10 "$AGENT/api/incidents?limit=1" | python3 -c 'import json,sys; d=json.load(sys.stdin)["incidents"]; print(d[0]["id"] if d and d[0].get("note") else "")')"
  if [[ -n "$id" && "$id" != "$before" ]]; then
    echo "✓ triaged $id"
    curl -fsS -m 10 "$AGENT/api/incidents/$id" | python3 "$(dirname "$0")/show-incident.py"
    exit 0
  fi
  sleep 5
done
echo "✗ no triage note within ${TIMEOUT}s" >&2
exit 1
