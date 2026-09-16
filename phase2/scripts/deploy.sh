#!/usr/bin/env bash
# Full deploy pipeline: e2e gate, build & push, apply, verify, roll back on failure.
# See docs/superpowers/specs/2026-09-08-phase2-deploy-observability-design.md
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IAC_DIR="$REPO_ROOT/phase2/iac"
VERIFY_DIR="$REPO_ROOT/phase2/packages/deploy-verify"
SERVICE_NAME="ghost-phase2"
REGION="us-east-1"

tofu_() { nix-shell -p opentofu --run "cd '$IAC_DIR' && tofu $*"; }

echo "== Step 1/5: sqlite-s3 e2e (real S3, gates deploy) =="
if ! (cd "$REPO_ROOT/phase2/packages/sqlite-s3" && npm run test:e2e); then
  echo "DEPLOY FAILED at sqlite-s3 e2e suite -- not proceeding to build/deploy." >&2
  exit 1
fi

echo "== Step 2/5: build & push =="
NEW_TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
"$REPO_ROOT/phase2/docker/build.sh"

echo "== Step 3/5: tofu apply (image_tag=$NEW_TAG) =="
# The phase1->phase2 cutover (see phase2/readme.md) already happened and set
# deploy_cloudfront=true in the real, live state -- omitting it here (as this
# script originally did, back when cutover was still a future, separate,
# explicit apply) makes every routine deploy try to revert the live
# CloudFront cutover back to deploy_cloudfront's `false` default, which very
# nearly destroyed the in-use origin access control on 2026-09-10. Passing
# it explicitly here just keeps this apply matching already-live state; it
# does not re-trigger the cutover itself.
if ! tofu_ "apply -auto-approve -var deploy_lightsail=true -var deploy_cloudfront=true -var image_tag=$NEW_TAG"; then
  echo "DEPLOY FAILED at tofu apply." >&2
  echo "Check the error above -- it may be the Lightsail deployment itself, or an unrelated resource in this same apply. Check 'aws lightsail get-container-service-deployments' for whether a new version actually went ACTIVE despite the reported failure." >&2
  exit 1
fi

PUBLIC_URL="$(tofu_ "output -raw public_url")"
BUCKET="$(tofu_ "output -raw bucket_name")"

echo "== Step 4/5: verification (smoke test + Admin API roundtrip) =="
GHOST_ADMIN_API_KEY="$(aws ssm get-parameter --name ghost_phase2_admin_api_key --with-decryption --region "$REGION" --query Parameter.Value --output text)"
export GHOST_ADMIN_API_KEY

if node "$VERIFY_DIR/bin/verify.mjs" --public-url "$PUBLIC_URL" --bucket "$BUCKET"; then
  echo "== Step 5/5: SUCCESS -- $NEW_TAG is live and verified =="
  exit 0
fi

echo "Verification failed for $NEW_TAG. Looking up the previous deployment to roll back to..." >&2

DEPLOYMENTS_JSON="$(aws lightsail get-container-service-deployments --service-name "$SERVICE_NAME" --region "$REGION")"
if ! PREVIOUS_TAG="$(echo "$DEPLOYMENTS_JSON" | node "$VERIFY_DIR/bin/previous-tag.mjs")"; then
  echo "DEPLOY FAILED verification, and there is no previous deployment to roll back to (first-ever deploy)." >&2
  echo "The new, failing deployment ($NEW_TAG) is left live -- there is nothing safer to fall back to." >&2
  exit 1
fi

echo "== Step 5/5: rolling back to $PREVIOUS_TAG =="
if ! tofu_ "apply -auto-approve -var deploy_lightsail=true -var deploy_cloudfront=true -var image_tag=$PREVIOUS_TAG"; then
  echo "ROLLBACK ALSO FAILED. Manual intervention needed. Currently-live tag is whatever Lightsail last had ACTIVE (check 'aws lightsail get-container-service-deployments')." >&2
  exit 1
fi

echo "DEPLOY FAILED verification for $NEW_TAG. Rolled back successfully -- $PREVIOUS_TAG is now live." >&2
exit 1
