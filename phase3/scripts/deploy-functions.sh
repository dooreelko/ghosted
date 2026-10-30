#!/usr/bin/env bash
# Deploy the built zip to the named Ghost-backed functions (code and entry
# point; configuration stays with OpenTofu). The entry for function X is
# lambda/src/X.mjs inside the zip.
#
# Usage: phase3/scripts/deploy-functions.sh <function>...   e.g. members-session
# Needs phase3/build/ghost-functions-arm64.zip (phase3/scripts/build-functions.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ZIP="$ROOT/phase3/build/ghost-functions-arm64.zip"
[ -f "$ZIP" ] || { echo "build the zip first: phase3/scripts/build-functions.sh" >&2; exit 1; }
[ "$#" -gt 0 ] || { echo "usage: $0 <function>..." >&2; exit 1; }

for fn in "$@"; do
  unzip -l "$ZIP" "lambda/src/$fn.mjs" >/dev/null 2>&1 || { echo "no entry for $fn in the zip" >&2; exit 1; }
  name="ghost-phase3-$fn"
  echo "== $name"
  aws lambda update-function-code --function-name "$name" --zip-file "fileb://$ZIP" --architectures arm64 \
    --query '[FunctionName,CodeSize,LastUpdateStatus]' --output text
  aws lambda wait function-updated --function-name "$name"
  aws lambda update-function-configuration --function-name "$name" --handler "lambda/src/$fn.handler" \
    --query '[FunctionName,Handler,MemorySize]' --output text
  aws lambda wait function-updated --function-name "$name"
done
