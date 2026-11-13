#!/usr/bin/env bash
# Kubernetes smoke test: install the chart, run helm test, break the demo system, and wait for
# Firstlook's triage note. Used by CI on a kind cluster; works against any cluster you point it at.
#   IMAGE_TAG=dev ./scripts/k8s-smoke.sh [scenario]
set -euo pipefail

SCENARIO="${1:-bad-deploy}"
NS="${NAMESPACE:-firstlook}"
TAG="${IMAGE_TAG:-dev}"
CHART="$(dirname "$0")/../deploy/helm/firstlook"

echo "→ helm install (images :$TAG)"
helm upgrade --install firstlook "$CHART" -n "$NS" --create-namespace \
  --set image.tag="$TAG" --set image.pullPolicy=IfNotPresent \
  --set agent.investigateDelayMs=45000 --wait --timeout 6m
kubectl -n "$NS" get pods

echo "→ helm test"
helm test firstlook -n "$NS" --logs

ADMIN_TOKEN="$(kubectl -n "$NS" get secret firstlook-firstlook -o jsonpath='{.data.admin-token}' | base64 -d)"
kubectl -n "$NS" port-forward svc/demo-api 18081:8081 >/dev/null 2>&1 &
PF1=$!
kubectl -n "$NS" port-forward svc/agent 18080:8080 >/dev/null 2>&1 &
PF2=$!
trap 'kill $PF1 $PF2 2>/dev/null || true' EXIT
sleep 3

# Let Prometheus collect a baseline before breaking anything.
echo "→ waiting 90s for a baseline"
sleep 90

API_URL=http://localhost:18081 AGENT_URL=http://localhost:18080 ADMIN_TOKEN="$ADMIN_TOKEN" \
  "$(dirname "$0")/e2e.sh" "$SCENARIO" 420 | tee /tmp/k8s-smoke.log

case "$SCENARIO" in
  bad-deploy) grep -q "1.4.1" /tmp/k8s-smoke.log ;;
  dependency-outage) grep -q "payments-stub is failing" /tmp/k8s-smoke.log ;;
  memory-leak) grep -q "1.4.2" /tmp/k8s-smoke.log ;;
  noisy-blip) grep -q "noise" /tmp/k8s-smoke.log ;;
esac
echo "✓ full loop on Kubernetes: alert → investigation → correct triage note"
