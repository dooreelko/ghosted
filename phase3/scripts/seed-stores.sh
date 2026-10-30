#!/usr/bin/env bash
# Cutover step 1: copy Phase 2's data into the Phase 3 buckets. Reads Phase 2's
# store and image keys and writes only to the two new buckets; Phase 2 keeps
# serving untouched. Refuses to seed a store that already holds data.
#
# The dumped database is migrated offline to the Ghost release the functions
# run (a boot of that release's image against the plain file), so no function
# ever migrates through the store on a cold start.
#
# Usage: GHOST_IMAGE=<ghost image the zip is built from> phase3/scripts/seed-stores.sh
#   RESEED=1 first empties the Phase 3 store bucket (a copy; Phase 2 is untouched).
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

echo "== migrate the file to the functions' Ghost release"
podman run --rm --user root -v "$TMP:/data:Z" --entrypoint sh "${GHOST_IMAGE:?set GHOST_IMAGE (see .local-secrets.md)}" -c \
  'cd /home/ghost && GHOST_CI_SHUTDOWN_AFTER_BOOT=1 NODE_ENV=production url=http://localhost:2368/blog database__client=better-sqlite3 database__connection__filename=/data/ghost.db logging__level=warn node index.js'

if [ "${RESEED:-}" = 1 ]; then
  echo "== emptying the Phase 3 store bucket (RESEED=1)"
  aws s3 rm "s3://$STORE" --recursive --only-show-errors
fi

echo "== seed the Phase 3 store"
node "$TOOLS/seed-from-sqlite.mjs" --db "$TMP/ghost.db" --bucket "$STORE"

echo "== copy images to the content bucket (same keys)"
aws s3 sync "s3://$SRC/blog/content/images/" "s3://$CONTENT/blog/content/images/" --only-show-errors
echo "images copied: $(aws s3 ls "s3://$CONTENT/blog/content/images/" --recursive --summarize | tail -2 | tr '\n' ' ')"
