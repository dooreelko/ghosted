#!/usr/bin/env bash
# Two-stage build: Ghost's own production image (target=full, unmodified),
# then this repo's launcher layer on top. Run from the repo root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GHOST_DIR="$REPO_ROOT/Ghost"
SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
BASE_TAG="ghost-phase2-base:$SHA"
FINAL_TAG="ghost-phase2:$SHA"

echo "== Building admin UI (needed by Dockerfile.production's full target) =="
docker run --rm -v "$GHOST_DIR":/work -w /work node:22.23.1-bookworm-slim bash -c \
  "corepack enable && pnpm install --frozen-lockfile --filter '@tryghost/admin...' && pnpm nx run @tryghost/admin:build"

echo "== Building Ghost's own production image (stage A, unmodified) =="
docker build -f "$GHOST_DIR/Dockerfile.production" --target full -t "$BASE_TAG" "$GHOST_DIR"

echo "== Building launcher layer (stage B) =="
docker build -f "$REPO_ROOT/phase2/docker/Dockerfile" --build-arg BASE_IMAGE="$BASE_TAG" -t "$FINAL_TAG" "$REPO_ROOT"

echo "== Built $FINAL_TAG =="
echo "$FINAL_TAG"
