#!/usr/bin/env bash
# Copy a file to/from the Ghost instance over SSM (the instance has no SSH,
# so this is the only transfer path — chunked base64 over
# `aws ssm send-command`, output for pull, command text for push).
#
# Usage:
#   scripts/ssm-scp.sh pull <remote-path> <local-path>
#   scripts/ssm-scp.sh push <local-path> <remote-path>
#
# Can be sourced instead of executed: other scripts that need the transfer
# primitives (not the CLI) can `source scripts/ssm-scp.sh --lib` to get
# INSTANCE_ID, run_command(), ssm_pull(), and ssm_push() without triggering
# the CLI dispatch at the bottom.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="$REPO_ROOT/.local-secrets.md"

PULL_CHUNK_BYTES=18000  # RunCommand stdout is capped per invocation; stay well under it
PUSH_CHUNK_BYTES=80000  # push chunks ride inside the command doc itself: AWS's real cap is
                         # MaxDocumentSizeExceeded at ~97KB total (empirically measured against
                         # this account/region — verified OK up to 98500 bytes of payload, fails
                         # at 99000), so 80000 leaves a solid margin for the fixed script text
                         # around each chunk.

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "error: $SECRETS_FILE not found (these scripts never hardcode the instance ID)" >&2
  exit 1
fi

INSTANCE_ID="$(grep -oP '^- Instance: \K\S+' "$SECRETS_FILE")"
if [[ -z "$INSTANCE_ID" ]]; then
  echo "error: could not find instance ID in $SECRETS_FILE (expected a line like '- Instance: i-...')" >&2
  exit 1
fi

# run_command SCRIPT — runs SCRIPT on the instance via AWS-RunShellScript,
# waits for completion, and prints its stdout. Exits non-zero (with stderr
# printed) if the remote command fails.
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

# ssm_pull REMOTE_PATH LOCAL_PATH — copies a file from the instance to a
# local path. Does not touch the remote file (read-only on that end).
ssm_pull() {
  local remote="$1" local_path="$2"
  local remote_b64="/tmp/ssm-scp-pull-$$.b64"

  local num_chunks
  num_chunks="$(run_command "base64 -w0 '$remote' > '$remote_b64' && split -b $PULL_CHUNK_BYTES -d '$remote_b64' '${remote_b64}.chunk-'; ls '${remote_b64}.chunk-'* | wc -l" | tr -d '[:space:]')"

  : > "$local_path.b64"
  local i
  for i in $(seq -w 0 $((num_chunks - 1))); do
    run_command "cat '${remote_b64}.chunk-${i}'" >> "$local_path.b64"
  done

  base64 -d "$local_path.b64" > "$local_path"
  rm -f "$local_path.b64"
  run_command "rm -f '$remote_b64' '${remote_b64}.chunk-'*" >/dev/null
}

# ssm_push LOCAL_PATH REMOTE_PATH — copies a local file to the instance.
ssm_push() {
  local local_path="$1" remote="$2"
  local remote_b64="/tmp/ssm-scp-push-$$.b64"

  run_command "rm -f '$remote_b64'" >/dev/null

  local local_b64="$(mktemp)"
  base64 -w0 "$local_path" > "$local_b64"
  split -b "$PUSH_CHUNK_BYTES" -d "$local_b64" "$local_b64.chunk-"
  rm -f "$local_b64"

  local chunk
  for chunk in "$local_b64.chunk-"*; do
    local content
    content="$(cat "$chunk")"
    run_command "printf '%s' '$content' >> '$remote_b64'" >/dev/null
  done
  rm -f "$local_b64.chunk-"*

  run_command "base64 -d '$remote_b64' > '$remote' && rm -f '$remote_b64'" >/dev/null
}

if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  # Sourced (e.g. `source scripts/ssm-scp.sh --lib`) — stop here, leave the
  # CLI dispatch below unexecuted so the sourcing script's own $1 is untouched.
  return 0
fi

case "${1:-}" in
  pull)
    [[ $# -eq 3 ]] || { echo "usage: $0 pull <remote-path> <local-path>" >&2; exit 1; }
    ssm_pull "$2" "$3"
    echo "pulled: $3"
    ;;
  push)
    [[ $# -eq 3 ]] || { echo "usage: $0 push <local-path> <remote-path>" >&2; exit 1; }
    ssm_push "$2" "$3"
    echo "pushed: $3"
    ;;
  *)
    echo "usage: $0 pull <remote-path> <local-path>" >&2
    echo "       $0 push <local-path> <remote-path>" >&2
    exit 1
    ;;
esac
