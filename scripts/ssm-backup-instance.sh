#!/usr/bin/env bash
# Back up the Ghost instance's config and posts (not its software) to a local
# file, over SSM only (the instance has no SSH). Run before any change to
# CloudFront or the instance's nginx/Ghost config.
#
# Backs up:
#   - Ghost's config.production.json
#   - Ghost's SQLite data directory (the posts database)
#   - /etc/nginx/sites-enabled/ (the reverse-proxy config)
#
# Does NOT back up: Ghost/node_modules/themes (software - reinstallable).
#
# Two extra modes exist for the phase 2 migration (moth i8hlt):
#
#   --vacuum-db
#       Also produce a clean, single-file SQLite snapshot via `VACUUM INTO`
#       and pull it out alongside the tarball. A plain file copy of a live
#       Ghost database is torn and leaves the WAL in a separate file; the
#       phase 2 seeder needs one consistent file.
#
#   --sync-images s3://BUCKET/PREFIX
#       Sync content/images straight from the instance to S3 at their FINAL
#       live location (no staging copy). Requires the instance role to hold
#       s3:PutObject/s3:ListBucket on that prefix. Resumable and idempotent.
#
# Usage: scripts/ssm-backup-instance.sh [--vacuum-db] [--sync-images S3_URI]
# Output: .instance-backups/<timestamp>.tgz (gitignored)
#         .instance-backups/<timestamp>.db   (with --vacuum-db)

set -euo pipefail

VACUUM_DB=false
SYNC_IMAGES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vacuum-db)
      VACUUM_DB=true
      shift
      ;;
    --sync-images)
      SYNC_IMAGES="${2:-}"
      if [[ -z "$SYNC_IMAGES" ]]; then
        echo "--sync-images needs an s3:// URI in form s3://BUCKET/PREFIX" >&2
        exit 1
      fi
      if [[ "$SYNC_IMAGES" != s3://* ]]; then
        echo "error: --sync-images argument must start with s3://, got: $SYNC_IMAGES" >&2
        exit 1
      fi
      if [[ "$SYNC_IMAGES" == *\'* ]]; then
        echo "error: --sync-images argument cannot contain single quotes" >&2
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "usage: $0 [--vacuum-db] [--sync-images s3://BUCKET/PREFIX]" >&2
      exit 1
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_ROOT/scripts/ssm-scp.sh" --lib

OUT_DIR="$REPO_ROOT/.instance-backups"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
REMOTE_TGZ="/tmp/ghost-backup-${TS}.tgz"
LOCAL_TGZ="$OUT_DIR/${TS}.tgz"

mkdir -p "$OUT_DIR"

echo "Building archive on the instance..."
run_command "sudo tar czf $REMOTE_TGZ -C / \
  var/www/ghost/config.production.json \
  var/www/ghost/content/data \
  etc/nginx/sites-enabled \
  2>/tmp/ghost-backup-tar.err || (cat /tmp/ghost-backup-tar.err >&2; exit 1); \
  sudo chmod 644 $REMOTE_TGZ; \
  echo done" >/dev/null

echo "Fetching archive..."
ssm_pull "$REMOTE_TGZ" "$LOCAL_TGZ"

echo "Cleaning up remote temp files..."
run_command "rm -f $REMOTE_TGZ /tmp/ghost-backup-tar.err" >/dev/null

echo "Backup saved: $LOCAL_TGZ"
tar tzf "$LOCAL_TGZ"

if [[ "$VACUUM_DB" == true ]]; then
  REMOTE_DB="/tmp/ghost-snapshot-${TS}.db"
  LOCAL_DB="$OUT_DIR/${TS}.db"

  # Cleanup trap: remove remote temp file on exit, regardless of success or failure.
  # Use set +e to prevent the cleanup itself from masking the original exit code.
  trap 'set +e; run_command "rm -f $REMOTE_DB" >/dev/null 2>&1' EXIT

  echo "Taking a clean database snapshot with VACUUM INTO..."
  # VACUUM INTO reads the live database and writes a new, fully-checkpointed
  # single file; it never modifies the source. A plain `cp` of a running
  # Ghost's ghost.db is torn and leaves the WAL behind in a separate file.
  # The command chain uses && so that any step's failure stops the chain;
  # sqlite3 on a missing file creates an empty one and reports `ok`, so a
  # `;` chain cannot distinguish a failed VACUUM from a successful one.
  run_command "sudo rm -f $REMOTE_DB && \
    sudo sqlite3 /var/www/ghost/content/data/ghost.db \"VACUUM INTO '$REMOTE_DB'\" && \
    sudo test -s $REMOTE_DB && \
    sudo chmod 644 $REMOTE_DB && \
    sudo sqlite3 $REMOTE_DB 'PRAGMA integrity_check;'" >/dev/null

  echo "Fetching database snapshot..."
  ssm_pull "$REMOTE_DB" "$LOCAL_DB"

  echo "Database snapshot saved: $LOCAL_DB"
fi

if [[ -n "$SYNC_IMAGES" ]]; then
  echo "Syncing images to $SYNC_IMAGES ..."
  # Runs on the instance under the instance role's own credentials, so the
  # ~15MB of images never travel through the SSM base64 channel (which caps
  # out in the low single-digit MB). `s3 sync` is resumable and idempotent.
  run_command "sudo aws s3 sync /var/www/ghost/content/images '$SYNC_IMAGES' --only-show-errors && echo sync-ok"

  echo "Image sync complete."
fi
