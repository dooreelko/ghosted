#!/usr/bin/env bash
# Build the shared zip for the Ghost-backed functions: Ghost's tree pruned to
# what the entry files load, plus the function code and the natives for the
# target architecture. Runs in the Ghost image under podman; needs network.
#
# Usage: phase3/scripts/build-functions.sh [arm64|x64] [image]   (image defaults to $GHOST_IMAGE)
#   arm64 (default): the Lambda zip, build/ghost-functions-arm64.zip.
#   x64: same layout with runnable natives, for the local smoke run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARCH="${1:-arm64}"
IMAGE="${2:-${GHOST_IMAGE:?pass the Ghost image as the second argument or set GHOST_IMAGE (see .local-secrets.md)}}"
OUT="$ROOT/phase3/build/$ARCH"

mkdir -p "$OUT"
podman run --rm --user root -e ARCH="$ARCH" \
  -v "$ROOT/phase3/packages:/src:ro,Z" \
  -v "$ROOT/phase3/scripts/build:/build:ro,Z" \
  -v "$OUT:/out:Z" \
  --entrypoint sh "$IMAGE" /build/in-container.sh

rm -f "$ROOT/phase3/build/ghost-functions-$ARCH.zip"
(cd "$OUT/root" && zip -qry "$ROOT/phase3/build/ghost-functions-$ARCH.zip" . -x 'lambda/test/*')
ls -la "$ROOT/phase3/build/ghost-functions-$ARCH.zip"
