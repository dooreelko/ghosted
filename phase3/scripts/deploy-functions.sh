#!/usr/bin/env bash
# Deploy the built zip to the named Ghost-backed functions (code and entry
# point; configuration stays with OpenTofu). The entry for function X is
# lambda/src/X.mjs inside the zip.
#
# Usage: phase3/scripts/deploy-functions.sh <function>...   e.g. members-session
# Needs phase3/build/ghost-functions-arm64.zip (phase3/scripts/build-functions.sh) and the deploy bucket (OpenTofu, flag deploy_functions).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ZIP="$ROOT/phase3/build/ghost-functions-arm64.zip"
[ -f "$ZIP" ] || { echo "build the zip first: phase3/scripts/build-functions.sh" >&2; exit 1; }
[ "$#" -gt 0 ] || { echo "usage: $0 <function>..." >&2; exit 1; }

# The zip is staged in the deploy bucket (the direct upload limit is 50 MB); the name follows the account.
BUCKET="ghost-phase3-deploy-$(aws sts get-caller-identity --query Account --output text)"
KEY="ghost-functions-arm64-$(date -u +%Y%m%dT%H%M%S).zip"
aws s3 cp "$ZIP" "s3://$BUCKET/$KEY" --only-show-errors

for fn in "$@"; do
  unzip -l "$ZIP" "lambda/src/$fn.mjs" >/dev/null 2>&1 || { echo "no entry for $fn in the zip" >&2; exit 1; }
  name="ghost-phase3-$fn"
  echo "== $name"
  aws lambda update-function-code --function-name "$name" --s3-bucket "$BUCKET" --s3-key "$KEY" --architectures arm64 \
    --query '[FunctionName,CodeSize,LastUpdateStatus]' --output text
  aws lambda wait function-updated --function-name "$name"
  aws lambda update-function-configuration --function-name "$name" --handler "lambda/src/$fn.handler" \
    --query '[FunctionName,Handler,MemorySize]' --output text
  aws lambda wait function-updated --function-name "$name"
done
