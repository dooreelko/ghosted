#!/usr/bin/env bash
# Publish Ghost's built admin client (static files in the Ghost image) to the
# Phase 3 content bucket under <base>/ghost/, where the edge serves it.
# Source maps are left out. Hashed assets are cached for a year; the entry
# page is not cached. Only touches keys under ghost/ (the generator never does).
#
# Usage: phase3/scripts/publish-admin-client.sh [image]   (default: the public base image)
# Needs the content bucket name in $CONTENT_BUCKET (see .local-secrets.md).
set -euo pipefail
IMAGE="${1:-docker.io/library/ghost-phase3-base:v6.73.0}"
BASE="${BASE_PATH:-blog}"
: "${CONTENT_BUCKET:?set CONTENT_BUCKET to the Phase 3 content bucket}"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CID="$(podman create "$IMAGE")"; trap 'podman rm "$CID" >/dev/null; rm -rf "$TMP"' EXIT
podman cp "$CID:/home/ghost/core/built/admin/." "$TMP/admin"

DEST="s3://$CONTENT_BUCKET/$BASE/ghost"
aws s3 sync "$TMP/admin/assets" "$DEST/assets" --exclude '*.map' --delete \
  --cache-control 'public, max-age=31536000, immutable' --only-show-errors
aws s3 cp "$TMP/admin/index.html" "$DEST/index.html" \
  --cache-control 'no-cache' --content-type 'text/html; charset=utf-8' --only-show-errors
echo "published $(find "$TMP/admin" -type f ! -name '*.map' | wc -l) files to $DEST"
