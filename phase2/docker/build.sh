#!/usr/bin/env bash
# Two-stage build: Ghost's own production image (target=full, unmodified),
# then this repo's launcher layer on top. Run from the repo root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GHOST_DIR="$REPO_ROOT/Ghost"
SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"

if [ -n "$(git -C "$REPO_ROOT" status --porcelain --ignore-submodules)" ]; then
  echo "ERROR: refusing to build from a dirty tree -- the resulting image tag would not uniquely identify its contents" >&2
  exit 1
fi

BASE_TAG="ghost-phase2-base:$SHA"
FINAL_TAG="ghost-phase2:$SHA"

echo "== Building admin UI (needed by Dockerfile.production's full target) =="
docker run --rm --user "$(id -u):$(id -g)" -v "$GHOST_DIR":/work -w /work node:22.23.1-bookworm-slim bash -c \
  "corepack enable && pnpm install --frozen-lockfile --filter '@tryghost/admin...' && pnpm nx run @tryghost/admin:build"

echo "== Building Ghost's own production image (stage A, unmodified) =="
docker build -f "$GHOST_DIR/Dockerfile.production" --target full -t "$BASE_TAG" "$GHOST_DIR"

echo "== Building launcher layer (stage B) =="
docker build -f "$REPO_ROOT/phase2/docker/Dockerfile" --build-arg BASE_IMAGE="$BASE_TAG" -t "$FINAL_TAG" "$REPO_ROOT"

echo "== Built $FINAL_TAG =="
echo "$FINAL_TAG"

ECR_URL="$(nix-shell -p opentofu --run "cd $REPO_ROOT/phase2/iac && tofu output -raw ecr_repository_url")"
ECR_TAG="$ECR_URL:$SHA"

echo "== Authenticating docker to ECR =="
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${ECR_URL%%/*}"

echo "== Tagging and pushing $ECR_TAG =="
docker tag "$FINAL_TAG" "$ECR_TAG"
docker push "$ECR_TAG"

echo "== Pushed $ECR_TAG =="
echo "$ECR_TAG"
