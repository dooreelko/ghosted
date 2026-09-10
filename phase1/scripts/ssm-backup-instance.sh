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
# Usage: phase1/scripts/ssm-backup-instance.sh [--vacuum-db] [--sync-images S3_URI]
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
source "$REPO_ROOT/phase1/scripts/ssm-scp.sh" --lib

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
  REMOTE_VACUUM_JS="/tmp/ghost-remote-vacuum-${TS}.js"
  LOCAL_DB="$OUT_DIR/${TS}.db"

  # Cleanup trap: remove remote temp file on exit, regardless of success or failure.
  # run_command calls `exit 1` internally on failure, and that exit terminates
  # the script immediately -- the trailing `|| true` never even runs, since
  # there's no process left to run it in. Left unguarded, a failing cleanup
  # here would silently override the script's real exit code with 1. Running
  # it in a subshell contains that: `exit` inside the subshell only ends the
  # subshell, so `|| true` outside it can actually catch the failure.
  trap '( run_command "rm -f $REMOTE_DB ${REMOTE_DB}.gz $REMOTE_VACUUM_JS" ) >/dev/null 2>&1 || true' EXIT

  echo "Taking a clean database snapshot with VACUUM INTO..."
  # VACUUM INTO reads the live database and writes a new, fully-checkpointed
  # single file; it never modifies the source. A plain `cp` of a running
  # Ghost's ghost.db is torn and leaves the WAL behind in a separate file.
  #
  # The work is done by phase1/scripts/remote-vacuum.js, shipped to the instance
  # base64-encoded so no quoting has to survive both the local shell and the
  # remote one. It runs under Ghost's own vendored better-sqlite3 because the
  # appserver has no sqlite3 CLI (confirmed: `apt-cache policy sqlite3` →
  # "Installed: (none)"), and installing a package on a production instance
  # just to take a backup is the worse trade. That script also asserts
  # integrity_check's OUTPUT rather than its exit code, since a corrupt
  # database reports its problems as result rows and still succeeds as a
  # query.
  #
  # The chain uses && so any step's failure stops it: a later step that finds
  # no file must not be able to create an empty one and pronounce it healthy.
  VACUUM_JS_B64="$(base64 -w0 "$REPO_ROOT/phase1/scripts/remote-vacuum.js")"

  run_command "sudo rm -f $REMOTE_DB && \
    echo '$VACUUM_JS_B64' | base64 -d > $REMOTE_VACUUM_JS && \
    sudo node $REMOTE_VACUUM_JS /var/www/ghost/current/node_modules \
      /var/www/ghost/content/data/ghost.db $REMOTE_DB && \
    sudo test -s $REMOTE_DB && \
    sudo gzip -f $REMOTE_DB && \
    sudo chmod 644 ${REMOTE_DB}.gz"

  # Pull the snapshot COMPRESSED. Every byte here rides the SSM channel as
  # base64 inside command output, chunked at ~18KB per round trip, so the
  # transfer cost is linear in payload size and a Ghost database compresses
  # to a small fraction of itself. Uncompressed, a 3.3MB database is roughly
  # 245 round trips; gzipped it is a few dozen.
  echo "Fetching database snapshot..."
  ssm_pull "${REMOTE_DB}.gz" "${LOCAL_DB}.gz"
  gunzip -f "${LOCAL_DB}.gz"

  echo "Database snapshot saved: $LOCAL_DB"
fi

if [[ -n "$SYNC_IMAGES" ]]; then
  echo "Syncing images to $SYNC_IMAGES ..."
  # Runs on the instance under the instance role's own credentials, so the
  # ~15MB of images never travel through the SSM base64 channel (which caps
  # out in the low single-digit MB). `s3 sync` is resumable and idempotent.
  run_command "sudo aws s3 sync /var/www/ghost/content/images '$SYNC_IMAGES' --region us-east-1 --only-show-errors && echo sync-ok"

  echo "Image sync complete."
fi
