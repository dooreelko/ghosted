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
#   4. Run sqlite-s3's own e2e Cucumber suite (real S3, multi-writer
#      reconciliation) — fully automated, manages its own throwaway
#      bucket lifecycle. This is the unattended-safe verification; run
#      first so a real regression is caught before touching Ghost/Docker.
#   5. Create a random throwaway S3 bucket (unless SQLITE_S3_BUCKET is
#      already set) and run the sqlite-s3 smoke test against fork_main +
#      current sqlite-s3. This part is the bimodal one: it has a manual
#      "create a post" gate, so it only completes when run attended.
#      Optimistic: just attempts it, so this step fails outright if AWS
#      credentials aren't available, or if unattended — that's expected,
#      not handled specially. On success, tears down the smoke containers
#      and deletes the bucket (only if this script created it). On
#      failure, leaves both in place for debugging — matches "stop and
#      report, never auto-revert" above.
#
# Usage: scripts/sync-ghost.sh
# Optional: SQLITE_S3_BUCKET, SQLITE_S3_REGION (default: a random
# `sqlite-s3-smoke-<timestamp>-<random>` bucket in us-east-1). AWS
# credentials for creating/using that bucket (both this and the e2e
# suite's own bucket).

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

echo "== Running sqlite-s3 e2e suite (real S3, own throwaway bucket) =="
npm --prefix "$SQLITE_S3_DIR" run test:e2e

echo "== Running sqlite-s3 smoke test against fork_main (now checked out in $GHOST_DIR) =="
export SQLITE_S3_REGION="${SQLITE_S3_REGION:-us-east-1}"
WE_CREATED_BUCKET=0
if [ -z "${SQLITE_S3_BUCKET:-}" ]; then
  export SQLITE_S3_BUCKET="sqlite-s3-smoke-$(date +%s)-$RANDOM"
  WE_CREATED_BUCKET=1
  echo "SQLITE_S3_BUCKET not set — creating throwaway bucket $SQLITE_S3_BUCKET"
  "$SQLITE_S3_DIR/smoke/create-bucket.sh" "$SQLITE_S3_BUCKET" "$SQLITE_S3_REGION"
fi
"$SQLITE_S3_DIR/smoke/run-smoke-test.sh"

# Only reached on success — the smoke test's own `set -e` stops this script
# first on failure, leaving the bucket/containers for post-mortem.
echo "== Smoke test passed — tearing down containers =="
docker compose -f "$SQLITE_S3_DIR/smoke/docker-compose.smoke.yaml" down
if [ "$WE_CREATED_BUCKET" = 1 ]; then
  echo "== Deleting throwaway bucket $SQLITE_S3_BUCKET =="
  aws s3 rb "s3://$SQLITE_S3_BUCKET" --force
fi

echo "== Sync complete =="
