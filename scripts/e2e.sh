#!/usr/bin/env bash
# Phase 2 end-to-end check: break the demo system, wait for Firstlook's triage note, print it.
#   ./scripts/e2e.sh [scenario] [timeout-seconds]
set -euo pipefail

SCENARIO="${1:-bad-deploy}"
TIMEOUT="${2:-360}"
API="${API_URL:-http://localhost:8081}"
AGENT="${AGENT_URL:-http://localhost:8080}"
TOKEN="${ADMIN_TOKEN:-dev-admin-token}"

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "→ starting scenario: $SCENARIO"
curl -fsS -m 10 -X POST -H "x-admin-token: $TOKEN" "$API/admin/scenarios/$SCENARIO/start" >/dev/null
trap 'curl -fsS -m 10 -X POST -H "x-admin-token: $TOKEN" "$API/admin/scenarios/$SCENARIO/stop" >/dev/null || true' EXIT

deadline=$(( $(date +%s) + TIMEOUT ))
while (( $(date +%s) < deadline )); do
  # The incident whose note was written after we broke things (new, or reopened and re-investigated).
  id="$(curl -fsS -m 10 "$AGENT/api/incidents?limit=10" | python3 -c '
import json, sys
started = sys.argv[1]
for i in json.load(sys.stdin)["incidents"]:
    if i.get("note") and i.get("triagedAt", "") >= started:
        print(i["id"]); break
' "$started")"
  if [[ -n "$id" ]]; then
    echo "✓ triaged $id"
    curl -fsS -m 10 "$AGENT/api/incidents/$id" | python3 "$(dirname "$0")/show-incident.py"
    exit 0
  fi
  sleep 5
done
echo "✗ no triage note within ${TIMEOUT}s" >&2
exit 1
