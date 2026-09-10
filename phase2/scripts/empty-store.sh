#!/usr/bin/env bash
# Empties the SQLite-over-S3 store: the manifest and every segment.
#
# The seeder (packages/sqlite-s3/bin/seed-from-sqlite.mjs) refuses to write
# over a store that already exists, and has no --force, because clearing one
# should be a separate and explicit act rather than a flag on the command
# that repopulates it. This is that act.
#
# Uploaded images are NOT touched. They live under blog/content/images/ in
# the same bucket, they are identical between one migration attempt and the
# next, and re-syncing 16MB from the instance to recover from a re-seed
# would be pure waste.
#
# Usage: phase2/scripts/empty-store.sh [--yes]
#   Without --yes it prints what it would delete and stops.

set -euo pipefail

ASSUME_YES=false
if [[ "${1:-}" == "--yes" ]]; then
  ASSUME_YES=true
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--yes]" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IAC_DIR="$REPO_ROOT/phase2/iac"

BUCKET="$(nix-shell -p opentofu --run "cd '$IAC_DIR' && tofu output -raw bucket_name")"
if [[ -z "$BUCKET" ]]; then
  echo "error: tofu output -raw bucket_name was empty -- has the prereq apply run?" >&2
  exit 1
fi

echo "Store contents in s3://$BUCKET (images excluded):"
SUMMARY="$(aws s3 ls "s3://$BUCKET/segments/" --recursive --summarize | tail -2)"
echo "$SUMMARY"
if aws s3 ls "s3://$BUCKET/root.json" >/dev/null 2>&1; then
  echo "  plus root.json (the manifest)"
else
  echo "  no root.json -- the store is already unseeded"
fi

if [[ "$ASSUME_YES" != true ]]; then
  echo
  echo "This would DELETE all of the above. Re-run with --yes to do it."
  echo "Uploaded images under blog/content/images/ are not touched."
  exit 0
fi

echo
echo "Deleting segments..."
aws s3 rm "s3://$BUCKET/segments/" --recursive --only-show-errors

echo "Deleting the manifest..."
aws s3 rm "s3://$BUCKET/root.json" --only-show-errors || true

echo "Done. Remaining objects in the bucket:"
aws s3 ls "s3://$BUCKET/" --recursive --summarize | tail -2
