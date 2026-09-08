#!/usr/bin/env bash
# Routine sync for the Ghost-fork + sqlite-s3 integration pipeline (moth
# yofwh). Manual trigger only (no CI/cron). Idempotent: safe to re-run for
# either trigger (new upstream Ghost commits, or a new sqlite-s3 commit in
# this repo).
#
# Steps:
#   1. Fast-forward the Ghost submodule's `main` onto `upstream/main`
#      (TryGhost/Ghost) and push to `origin` (the fork). Never rebases,
#      never force-pushes.
#   2. Merge `main` into `fork_main` (creating it from `main` on first run)
#      and push. `fork_main` is where the sqlite-s3 integration is
#      exercised; `main` itself stays a pure mirror.
#   3. If phase2/packages/sqlite-s3 changed since the launcher's pinned git
#      dependency ref, bump ghost-sqlite-s3-launcher/package.json to this
#      repo's current HEAD commit and report that a commit is needed here.
#   4. Run the sqlite-s3 smoke test against fork_main + current sqlite-s3.
#      On failure, stop and report — never auto-revert.
#
# Usage: scripts/sync-ghost.sh
# Requires: SQLITE_S3_BUCKET, SQLITE_S3_REGION set (passed through to the
# smoke test), AWS credentials for that bucket.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GHOST_DIR="$REPO_ROOT/Ghost"
LAUNCHER_PKG="$REPO_ROOT/phase2/packages/ghost-sqlite-s3-launcher/package.json"
SQLITE_S3_DIR="$REPO_ROOT/phase2/packages/sqlite-s3"

echo "== Fetching upstream + origin for the Ghost fork =="
git -C "$GHOST_DIR" fetch upstream
git -C "$GHOST_DIR" fetch origin

echo "== Fast-forwarding Ghost main onto upstream/main =="
git -C "$GHOST_DIR" checkout main
git -C "$GHOST_DIR" merge --ff-only upstream/main
git -C "$GHOST_DIR" push origin main

echo "== Syncing fork_main from main =="
if git -C "$GHOST_DIR" show-ref --verify --quiet refs/heads/fork_main; then
  git -C "$GHOST_DIR" checkout fork_main
else
  git -C "$GHOST_DIR" checkout -b fork_main main
fi
git -C "$GHOST_DIR" merge main --no-edit
git -C "$GHOST_DIR" push origin fork_main

echo "== Checking sqlite-s3 git-dependency ref =="
CURRENT_REPO_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
PINNED_SHA="$(node -pe "require('$LAUNCHER_PKG').dependencies['@ghost-phase2/sqlite-s3'].match(/#([0-9a-f]{40}):/)[1]")"
if [ "$CURRENT_REPO_SHA" != "$PINNED_SHA" ] \
  && ! git -C "$REPO_ROOT" diff --quiet "$PINNED_SHA" "$CURRENT_REPO_SHA" -- "$SQLITE_S3_DIR"; then
  echo "sqlite-s3 changed ($PINNED_SHA -> $CURRENT_REPO_SHA) — bumping launcher's pinned ref"
  sed -i "s/#$PINNED_SHA:/#$CURRENT_REPO_SHA:/" "$LAUNCHER_PKG"
  echo "NOTE: commit the updated $LAUNCHER_PKG before re-running (the pinned ref must point at a pushed commit)."
else
  echo "sqlite-s3 unchanged since $PINNED_SHA — nothing to bump"
fi

echo "== Running sqlite-s3 smoke test against fork_main (now checked out in $GHOST_DIR) =="
: "${SQLITE_S3_BUCKET:?set SQLITE_S3_BUCKET first}"
: "${SQLITE_S3_REGION:?set SQLITE_S3_REGION}"
"$SQLITE_S3_DIR/smoke/run-smoke-test.sh"

echo "== Sync complete =="
