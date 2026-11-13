#!/usr/bin/env bash
# Phase 1 smoke test: start a fault, then wait for Grafana's alert to reach the agent.
#   ./scripts/smoke.sh [scenario] [timeout-seconds]
set -euo pipefail

SCENARIO="${1:-bad-deploy}"
TIMEOUT="${2:-240}"
API="${API_URL:-http://localhost:8081}"
TOKEN="${ADMIN_TOKEN:-dev-admin-token}"

echo "→ starting scenario: $SCENARIO"
curl -fsS -m 10 -X POST -H "x-admin-token: $TOKEN" "$API/admin/scenarios/$SCENARIO/start" >/dev/null

since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
deadline=$(( $(date +%s) + TIMEOUT ))
while (( $(date +%s) < deadline )); do
  if docker compose logs agent --since "$since" 2>/dev/null | grep -q '"msg":"alert received"'; then
    echo "✓ alert reached the agent:"
    docker compose logs agent --since "$since" --no-log-prefix 2>/dev/null | grep '"alert received"' | head -3
    curl -fsS -m 10 -X POST -H "x-admin-token: $TOKEN" "$API/admin/scenarios/$SCENARIO/stop" >/dev/null || true
    exit 0
  fi
  sleep 5
done

echo "✗ no alert within ${TIMEOUT}s" >&2
curl -fsS -m 10 -X POST -H "x-admin-token: $TOKEN" "$API/admin/scenarios/$SCENARIO/stop" >/dev/null || true
exit 1
