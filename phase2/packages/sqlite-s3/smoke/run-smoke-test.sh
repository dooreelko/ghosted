#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

: "${SQLITE_S3_BUCKET:?set SQLITE_S3_BUCKET first, e.g. from create-bucket.sh output}"
: "${SQLITE_S3_REGION:?set SQLITE_S3_REGION}"

echo "== Starting Ghost against $SQLITE_S3_BUCKET =="
docker compose -f docker-compose.smoke.yaml up -d

echo "== Waiting for Ghost to come up =="
for i in $(seq 1 60); do
  if curl -sf http://localhost:2368 > /dev/null; then break; fi
  sleep 2
done

echo "== Create a post titled 'smoke-test-post' via http://localhost:2368/ghost, then press enter. =="
read -r

echo "== Recreating the container (simulates a Lightsail redeploy with no persistent disk: /tmp/ghost-sqlite-s3 is container-local, not bind-mounted) =="
docker compose -f docker-compose.smoke.yaml down
docker compose -f docker-compose.smoke.yaml up -d

echo "== Waiting for Ghost to come back up =="
for i in $(seq 1 60); do
  if curl -sf http://localhost:2368 > /dev/null; then break; fi
  sleep 2
done

echo "== Verify: check http://localhost:2368 still shows 'smoke-test-post' =="
curl -s http://localhost:2368 | grep -q 'smoke-test-post' \
  && echo "PASS: post survived restart" \
  || { echo "FAIL: post missing after restart"; exit 1; }

echo "== Cleanup reminder =="
echo "docker compose -f docker-compose.smoke.yaml down"
echo "aws s3 rb s3://$SQLITE_S3_BUCKET --force"
