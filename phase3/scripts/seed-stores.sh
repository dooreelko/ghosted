#!/usr/bin/env bash
# Cutover step 1: copy Phase 2's data into the Phase 3 buckets. Reads Phase 2's
# store and image keys and writes only to the two new buckets; Phase 2 keeps
# serving untouched. Refuses to seed a store that already holds data.
#
# Usage: phase3/scripts/seed-stores.sh
# Needs the Phase 3 and Phase 2 OpenTofu backends (backend.hcl) and AWS credentials.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

out() { (cd "$ROOT/phase3/iac" && tofu output -raw "$1"); }
(cd "$ROOT/phase3/iac" && tofu init -backend-config=backend.hcl -input=false >/dev/null)
SRC="$(out bucket_name)"       # Phase 2 data bucket: store segments and images
STORE="$(out store_bucket)"
CONTENT="$(out content_bucket)"

echo "== sqlite-s3 tools (no native build needed here)"
(cd "$ROOT/phase3/packages/sqlite-s3" && npm install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
TOOLS="$ROOT/phase3/packages/sqlite-s3/bin"

echo "== dump the Phase 2 store to a plain file"
node "$TOOLS/dump-to-sqlite.mjs" --bucket "$SRC" --out "$TMP/ghost.db"

echo "== seed the Phase 3 store"
node "$TOOLS/seed-from-sqlite.mjs" --db "$TMP/ghost.db" --bucket "$STORE"

echo "== copy images to the content bucket (same keys)"
aws s3 sync "s3://$SRC/blog/content/images/" "s3://$CONTENT/blog/content/images/" --only-show-errors
echo "images copied: $(aws s3 ls "s3://$CONTENT/blog/content/images/" --recursive --summarize | tail -2 | tr '\n' ' ')"
