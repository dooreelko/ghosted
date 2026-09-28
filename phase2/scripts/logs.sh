#!/usr/bin/env bash
# Pull recent Lightsail container service logs.
# Usage: logs.sh [minutes]   (default 30)
set -exuo pipefail


SERVICE_NAME="ghost-phase2"
CONTAINER_NAME="ghost"
REGION="us-east-1"
MINUTES="${1:-30}"

if ! [[ "$MINUTES" =~ ^[0-9]+$ ]]; then
  echo "minutes must be a positive integer, got: $MINUTES" >&2
  exit 1
fi

START_TIME="$(date -u -d "-${MINUTES} minutes" +%Y-%m-%dT%H:%M:%SZ)"

aws lightsail get-container-log \
  --service-name "$SERVICE_NAME" \
  --container-name "$CONTAINER_NAME" \
  --region "$REGION" \
  --start-time "$START_TIME" \
  --query 'logEvents[].message' \
  --output text
