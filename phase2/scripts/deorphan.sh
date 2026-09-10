#!/usr/bin/env bash
# Sweep the sqlite-s3 data bucket for orphaned segments (moth rk2qo) --
# defaults to a dry run; pass --execute to actually delete. Resolves the
# bucket name from OpenTofu's own state rather than hardcoding it (the name
# embeds the account id -- see CLAUDE.md's Sensitive data rule).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IAC_DIR="$REPO_ROOT/phase2/iac"
RECLAIM_DIR="$REPO_ROOT/phase2/packages/sqlite-s3"

tofu_() { nix-shell -p opentofu --run "cd '$IAC_DIR' && tofu $*"; }

BUCKET="$(tofu_ "output -raw bucket_name")"

cd "$RECLAIM_DIR"
SQLITE_S3_BUCKET="$BUCKET" node scripts/reclaim-orphaned-segments.js "$@"
