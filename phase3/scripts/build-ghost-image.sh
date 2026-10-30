#!/usr/bin/env bash
# Build Ghost's own production image (target full) from a release tag of the
# Ghost clone, for use as the source tree of the Lambda zip. Works from a clean
# export of the tag (git archive), so leftovers in the clone's working tree
# cannot leak in, and the clone itself is not modified.
#
# Usage: phase3/scripts/build-ghost-image.sh [tag]      default v6.73.0
# Result: local image ghost-phase3-base:<tag>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAG="${1:-v6.73.0}"
SRC="$ROOT/phase3/build/ghost-src"
NODE_VERSION="$(git -C "$ROOT/Ghost" show "$TAG:.node-version" | tr -d '[:space:]')"

echo "== export $TAG"
rm -rf "$SRC" && mkdir -p "$SRC"
git -C "$ROOT/Ghost" archive "$TAG" | tar -x -C "$SRC"

echo "== default themes at the commits the tag pins (submodules are not in the archive)"
for t in casper source; do
  sha="$(git -C "$ROOT/Ghost" ls-tree "$TAG" "ghost/content/themes/$t" | awk '{print $3}')"
  repo="$(printf '%s' "$t" | sed 's/^./\U&/')"
  dest="$SRC/ghost/content/themes/$t"
  mkdir -p "$dest"
  git -C "$dest" init -q
  git -C "$dest" fetch -q --depth 1 "https://github.com/TryGhost/$repo.git" "$sha"
  git -C "$dest" checkout -q FETCH_HEAD
  rm -rf "$dest/.git"
done

echo "== admin UI (needed by the full target), Node $NODE_VERSION"
docker run --rm -v "$SRC":/work -w /work "node:$NODE_VERSION-bookworm-slim" bash -c \
  "corepack enable && pnpm install --frozen-lockfile --filter '@tryghost/admin...' && pnpm nx run @tryghost/admin:build && chown -R $(id -u):$(id -g) /work"

echo "== Ghost production image (full)"
docker build -f "$SRC/Dockerfile.production" --target full --build-arg NODE_VERSION="$NODE_VERSION" -t "ghost-phase3-base:$TAG" "$SRC"
echo "built ghost-phase3-base:$TAG"
