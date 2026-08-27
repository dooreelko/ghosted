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
# Does NOT back up: Ghost/node_modules/themes (software - reinstallable),
# uploaded images/media (large; add here later if ever needed).
#
# Usage: scripts/ssm-backup-instance.sh
# Output: .instance-backups/<timestamp>.tgz (gitignored)

set -euo pipefail

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
