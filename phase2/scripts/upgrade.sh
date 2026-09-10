#!/usr/bin/env bash
# Wraps deploy.sh for a Ghost VERSION upgrade -- not a routine same-version
# redeploy (use deploy.sh directly for that; it never touches the store's
# schema).
#
# Why this exists: a version upgrade can run a Ghost DB migration on boot.
# If verification then fails, the store may already be migrated forward --
# deploy.sh's own image-only rollback (redeploy the previous tag) is NOT
# guaranteed to actually fix anything, since old code reading new-schema
# data can be just as broken. Unlike the Phase 1->2 migration (see
# migration.md), there is no untouched second copy of the data to fall back
# to here -- the S3-backed store is the only copy.
#
# This script takes an SQLite-dump backup of the store before deploying,
# then: if the site is still unhealthy after deploy.sh's own rollback has
# run, it empties the (now-incompatible) store, restores it from that
# backup, and forces one more restart -- so the previous version ends up
# running against data it actually understands, not data left mid-migrated.
#
# Usage: phase2/scripts/upgrade.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
IAC_DIR="$REPO_ROOT/phase2/iac"
SQLITE_S3_DIR="$REPO_ROOT/phase2/packages/sqlite-s3"
VERIFY_DIR="$REPO_ROOT/phase2/packages/deploy-verify"
SERVICE_NAME="ghost-phase2"
REGION="us-east-1"
BACKUP_DIR="$REPO_ROOT/.instance-backups"

tofu_() { nix-shell -p opentofu --run "cd '$IAC_DIR' && tofu $*"; }

BUCKET="$(tofu_ "output -raw bucket_name")"
mkdir -p "$BACKUP_DIR"
BACKUP_PATH="$BACKUP_DIR/pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ).db"

echo "== Step 1/4: backing up the store before upgrading =="
node "$SQLITE_S3_DIR/bin/dump-to-sqlite.mjs" --bucket "$BUCKET" --out "$BACKUP_PATH"
echo "Backup written to $BACKUP_PATH -- keep it until you're confident this upgrade stuck."

echo "== Recording the currently active image tag (the restore target if this goes badly) =="
CURRENT_TAG_RAW="$(aws lightsail get-container-service-deployments --service-name "$SERVICE_NAME" --region "$REGION" \
  --query "deployments[?state=='ACTIVE'].containers.ghost.image | [0]" --output text)"
CURRENT_TAG="${CURRENT_TAG_RAW##*:}"
echo "Currently active tag: $CURRENT_TAG"

echo "== Step 2/4: running the normal deploy pipeline =="
if "$REPO_ROOT/phase2/scripts/deploy.sh"; then
  echo "== Step 4/4: SUCCESS -- upgrade deployed and verified. Backup kept at $BACKUP_PATH. =="
  exit 0
fi

echo "deploy.sh reported failure. Checking whether the site is actually healthy right now (it may already have self-rolled-back to a working state)..." >&2

PUBLIC_URL="$(tofu_ "output -raw public_url")"
GHOST_ADMIN_API_KEY="$(aws ssm get-parameter --name ghost_phase2_admin_api_key --with-decryption --region "$REGION" --query Parameter.Value --output text)"
export GHOST_ADMIN_API_KEY

if node "$VERIFY_DIR/bin/verify.mjs" --public-url "$PUBLIC_URL" --bucket "$BUCKET"; then
  echo "== Step 4/4: deploy.sh's own rollback already fixed it -- the previous version is live and verified healthy. No data restore needed. Backup kept at $BACKUP_PATH. ==" >&2
  exit 1
fi

echo "== Step 3/4: still unhealthy after deploy.sh's own rollback -- the store is likely schema-incompatible with the restored old version. Restoring from the pre-upgrade backup. ==" >&2
"$REPO_ROOT/phase2/scripts/empty-store.sh" --yes
node "$SQLITE_S3_DIR/bin/seed-from-sqlite.mjs" --db "$BACKUP_PATH" --bucket "$BUCKET"

echo "== Forcing a restart on the restored data (image_tag=$CURRENT_TAG) ==" >&2
tofu_ "apply -auto-approve -var deploy_lightsail=true -var deploy_cloudfront=true -var image_tag=$CURRENT_TAG -var redeploy=true"

echo "== Re-verifying after restore ==" >&2
if node "$VERIFY_DIR/bin/verify.mjs" --public-url "$PUBLIC_URL" --bucket "$BUCKET"; then
  echo "== Step 4/4: RESTORED -- $CURRENT_TAG is live again against the pre-upgrade data. Backup kept at $BACKUP_PATH. ==" >&2
else
  echo "== Step 4/4: STILL UNHEALTHY after data restore. Manual intervention needed -- do not delete $BACKUP_PATH. ==" >&2
fi
exit 1
