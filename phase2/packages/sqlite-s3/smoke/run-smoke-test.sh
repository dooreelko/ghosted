#!/usr/bin/env bash
# Prerequisite (one-time, on the Ghost checkout): the frontend card/JS/CSS
# assets must already be built, or boot fails with "Could not use the card
# asset manifest". From Ghost/ghost/core: `pnpm build:assets`.
set -euo pipefail
cd "$(dirname "$0")"

: "${SQLITE_S3_BUCKET:?set SQLITE_S3_BUCKET first, e.g. from create-bucket.sh output}"
: "${SQLITE_S3_REGION:?set SQLITE_S3_REGION}"

echo "== Starting Ghost against $SQLITE_S3_BUCKET =="
docker compose -f docker-compose.smoke.yaml up -d

echo "== Waiting for Ghost to come up =="
for i in $(seq 1 90); do
  if curl -sf http://localhost:2368 > /dev/null; then break; fi
  sleep 4
done

echo "== Creating owner account + 'smoke-test-post' via the Admin API =="
GHOST_URL="http://localhost:2368"
ADMIN_URL="$GHOST_URL/ghost/api/admin"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

# Ghost's HTTP server starts accepting connections (and serves 200 on /)
# before its DB init finishes — that can take 60-100s+ on this DB (S3
# restore + migrations), so the Admin API itself isn't up yet even once the
# wait loop above succeeds. Retry through that gap rather than racing it.
CURL_RETRY=(--retry 45 --retry-delay 3 --retry-all-errors --retry-connrefused)

curl -sf "${CURL_RETRY[@]}" -X POST "$ADMIN_URL/authentication/setup/" \
  -H 'Content-Type: application/json' -H "Origin: $GHOST_URL" \
  -d '{"setup":[{"name":"Smoke Test","email":"smoke@example.com","password":"SmokeTest123!","blogTitle":"Smoke Test Blog"}]}' \
  > /dev/null

curl -sf "${CURL_RETRY[@]}" -X POST "$ADMIN_URL/session/" \
  -H 'Content-Type: application/json' -H "Origin: $GHOST_URL" -c "$COOKIE_JAR" \
  -d '{"username":"smoke@example.com","password":"SmokeTest123!"}' \
  > /dev/null

curl -sf "${CURL_RETRY[@]}" -X POST "$ADMIN_URL/posts/?source=html" \
  -H 'Content-Type: application/json' -H "Origin: $GHOST_URL" -b "$COOKIE_JAR" \
  -d '{"posts":[{"title":"smoke-test-post","status":"published","html":"<p>smoke test</p>"}]}' \
  > /dev/null

rm -f "$COOKIE_JAR"
trap - EXIT

echo "== Recreating the container (simulates a Lightsail redeploy with no persistent disk: /tmp/ghost-sqlite-s3 is container-local, not bind-mounted) =="
docker compose -f docker-compose.smoke.yaml down
docker compose -f docker-compose.smoke.yaml up -d

echo "== Waiting for Ghost to come back up =="
for i in $(seq 1 90); do
  if curl -sf http://localhost:2368 > /dev/null; then break; fi
  sleep 4
done

echo "== Verify: check http://localhost:2368 still shows 'smoke-test-post' =="
curl -sf --retry 45 --retry-delay 3 --retry-all-errors --retry-connrefused http://localhost:2368 \
  | grep -q 'smoke-test-post' \
  && echo "PASS: post survived restart" \
  || { echo "FAIL: post missing after restart"; exit 1; }

echo "== Cleanup reminder =="
echo "docker compose -f docker-compose.smoke.yaml down"
echo "aws s3 rb s3://$SQLITE_S3_BUCKET --force"
