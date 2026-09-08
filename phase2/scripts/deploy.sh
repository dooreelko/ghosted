#!/usr/bin/env bash
# Full deploy pipeline: build & push, apply, verify, roll back on failure.
# See docs/superpowers/specs/2026-09-08-phase2-deploy-observability-design.md
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IAC_DIR="$REPO_ROOT/phase2/iac"
VERIFY_DIR="$REPO_ROOT/phase2/packages/deploy-verify"
SERVICE_NAME="ghost-phase2"
REGION="us-east-1"

tofu_() { nix-shell -p opentofu --run "cd '$IAC_DIR' && tofu $*"; }

echo "== Step 1/4: build & push =="
NEW_TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
"$REPO_ROOT/phase2/docker/build.sh"

echo "== Step 2/4: tofu apply (image_tag=$NEW_TAG) =="
if ! tofu_ "apply -auto-approve -var image_tag=$NEW_TAG"; then
  echo "DEPLOY FAILED at tofu apply -- Lightsail rejected the new version." >&2
  echo "The previously ACTIVE deployment is untouched and still serving. No rollback needed." >&2
  exit 1
fi

PUBLIC_URL="$(tofu_ "output -raw public_url")"
BUCKET="$(tofu_ "output -raw bucket_name")"

echo "== Step 3/4: verification (smoke test + Admin API roundtrip) =="
GHOST_ADMIN_API_KEY="$(aws ssm get-parameter --name ghost_phase2_admin_api_key --with-decryption --region "$REGION" --query Parameter.Value --output text)"
export GHOST_ADMIN_API_KEY

if node "$VERIFY_DIR/bin/verify.mjs" --public-url "$PUBLIC_URL" --bucket "$BUCKET"; then
  echo "== Step 4/4: SUCCESS -- $NEW_TAG is live and verified =="
  exit 0
fi

echo "Verification failed for $NEW_TAG. Looking up the previous deployment to roll back to..." >&2

DEPLOYMENTS_JSON="$(aws lightsail get-container-service-deployments --service-name "$SERVICE_NAME" --region "$REGION")"
if ! PREVIOUS_TAG="$(echo "$DEPLOYMENTS_JSON" | node "$VERIFY_DIR/bin/previous-tag.mjs")"; then
  echo "DEPLOY FAILED verification, and there is no previous deployment to roll back to (first-ever deploy)." >&2
  echo "The new, failing deployment ($NEW_TAG) is left live -- there is nothing safer to fall back to." >&2
  exit 1
fi

echo "== Step 4/4: rolling back to $PREVIOUS_TAG =="
if ! tofu_ "apply -auto-approve -var image_tag=$PREVIOUS_TAG"; then
  echo "ROLLBACK ALSO FAILED. Manual intervention needed. Currently-live tag is whatever Lightsail last had ACTIVE (check 'aws lightsail get-container-service-deployments')." >&2
  exit 1
fi

echo "DEPLOY FAILED verification for $NEW_TAG. Rolled back successfully -- $PREVIOUS_TAG is now live." >&2
exit 1
