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
SECRETS_FILE="$REPO_ROOT/.local-secrets.md"
OUT_DIR="$REPO_ROOT/.instance-backups"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
REMOTE_TGZ="/tmp/ghost-backup-${TS}.tgz"
LOCAL_TGZ="$OUT_DIR/${TS}.tgz"
CHUNK_BYTES=18000 # keeps each base64 chunk comfortably under RunCommand's
                   # ~24KB stdout-per-invocation limit

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "error: $SECRETS_FILE not found (this script never hardcodes the instance ID)" >&2
  exit 1
fi

INSTANCE_ID="$(grep -oP '^- Instance: \K\S+' "$SECRETS_FILE")"
if [[ -z "$INSTANCE_ID" ]]; then
  echo "error: could not find instance ID in $SECRETS_FILE (expected a line like '- Instance: i-...')" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

run_command() {
  local script="$1"
  local cmd_id
  cmd_id="$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --parameters "commands=[$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$script")]" \
    --query 'Command.CommandId' --output text)"
  aws ssm wait command-executed --command-id "$cmd_id" --instance-id "$INSTANCE_ID" 2>/dev/null || true
  local status
  status="$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$INSTANCE_ID" --query Status --output text)"
  if [[ "$status" != "Success" ]]; then
    echo "error: remote command failed (status=$status)" >&2
    aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$INSTANCE_ID" --query StandardErrorContent --output text >&2
    exit 1
  fi
  aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$INSTANCE_ID" --query StandardOutputContent --output text
}

echo "Building archive on the instance..."
run_command "sudo tar czf $REMOTE_TGZ -C / \
  var/www/ghost/config.production.json \
  var/www/ghost/content/data \
  etc/nginx/sites-enabled \
  2>/tmp/ghost-backup-tar.err || (cat /tmp/ghost-backup-tar.err >&2; exit 1); \
  sudo chmod 644 $REMOTE_TGZ; \
  echo done" >/dev/null

echo "Splitting into chunks and fetching..."
NUM_CHUNKS="$(run_command "base64 -w0 $REMOTE_TGZ > /tmp/ghost-backup.b64 && split -b $CHUNK_BYTES -d /tmp/ghost-backup.b64 /tmp/ghost-backup-chunk-; ls /tmp/ghost-backup-chunk-* | wc -l" | tr -d '[:space:]')"

: > "$LOCAL_TGZ.b64"
for i in $(seq -w 0 $((NUM_CHUNKS - 1))); do
  CHUNK_FILE="/tmp/ghost-backup-chunk-${i}"
  echo "  chunk $((10#$i + 1))/$NUM_CHUNKS"
  run_command "cat $CHUNK_FILE" >> "$LOCAL_TGZ.b64"
done

base64 -d "$LOCAL_TGZ.b64" > "$LOCAL_TGZ"
rm -f "$LOCAL_TGZ.b64"

echo "Cleaning up remote temp files..."
run_command "rm -f $REMOTE_TGZ /tmp/ghost-backup.b64 /tmp/ghost-backup-chunk-* /tmp/ghost-backup-tar.err" >/dev/null

echo "Backup saved: $LOCAL_TGZ"
tar tzf "$LOCAL_TGZ"
