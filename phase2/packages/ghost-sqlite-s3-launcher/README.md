# @ghost-phase2/ghost-sqlite-s3-launcher

Generalizes `phase2/packages/sqlite-s3/smoke/preload.mjs` into a reusable
launcher: same runtime monkeypatch/config-override mechanism (see that
package's README for how the S3-backed SQLite client itself works), but
driven entirely by environment variables instead of a hardcoded relative
path — so it can run against *any* Ghost checkout (e.g. the `fork_main`
branch of the Ghost fork), not just this monorepo's bind-mounted smoke
layout.

Ghost's own source tree is never modified. This package only patches
in-memory state (`@tryghost/database-info`'s SQLite detection) and
Ghost's config object, before `ghost/core/index.js` boots.

## Usage

```bash
GHOST_CHECKOUT_DIR=/path/to/ghost-fork-main-checkout \
SQLITE_S3_BUCKET=my-bucket \
SQLITE_S3_REGION=us-east-1 \
node --conditions=source --import=tsx \
  --import=@ghost-phase2/ghost-sqlite-s3-launcher/src/preload.mjs \
  "$GHOST_CHECKOUT_DIR/ghost/core/index.js"
```

Required env vars:

- `GHOST_CHECKOUT_DIR` — root of a Ghost checkout on the `fork_main`
  branch (or any branch with the same layout).
- `SQLITE_S3_BUCKET`, `SQLITE_S3_REGION` — S3 location for the
  segment/manifest store.

Optional:

- `SQLITE_S3_DATA_DIR` — local scratch path for the reconstructed SQLite
  file (default `/tmp/ghost-sqlite-s3`; must be writable, need not
  persist across restarts).
- `SQLITE_S3_MAX_WAL_BYTES`, `SQLITE_S3_MAX_CHECKPOINT_INTERVAL_MS` —
  checkpoint policy tuning (defaults: 50MB / 1 hour).
