#!/usr/bin/env bash
# Post-deploy gate: the smoke suite against an edge, then the CloudWatch checks for the same time window.
# Usage: SMOKE_BASE=https://<edge host> GHOST_ADMIN_API_KEY=<id:secret> [SMOKE_CONTENT_KEY=..] [SMOKE_SCHEDULED=1] phase3/scripts/run-smoke.sh
# Exit status: 0 only when the suite passes and the gate passes.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

node --test --test-timeout=480000 "$DIR/smoke/smoke.test.mjs"
SUITE=$?
node "$DIR/smoke/cloudwatch-gate.mjs" --since "$SINCE" --settle "${SMOKE_SETTLE:-120}"
GATE=$?

echo
[ $SUITE -eq 0 ] && echo "suite: passed" || echo "suite: FAILED"
[ $GATE -eq 0 ] && echo "gate:  passed" || echo "gate:  FAILED"
[ $SUITE -eq 0 ] && [ $GATE -eq 0 ]
