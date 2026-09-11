#!/usr/bin/env bash
# Force a fresh container boot -- no image rebuild, no functional config
# change. Flips the `redeploy` var's cosmetic REDEPLOY_MARKER env var (see
# iac/variables.tf) to trigger a new Lightsail deployment version. Useful to
# get a clean boot-time metric reading (e.g. after deorphan.sh) without
# running the full deploy.sh pipeline.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
IAC_DIR="$REPO_ROOT/phase2/iac"
SERVICE_NAME="ghost-phase2"
REGION="us-east-1"

tofu_() { nix-shell -p opentofu --run "cd '$IAC_DIR' && tofu $*"; }

CURRENT_JSON="$(aws lightsail get-container-service-deployments --service-name "$SERVICE_NAME" --region "$REGION" --query 'deployments[?state==`ACTIVE`] | [0]')"
IMAGE="$(echo "$CURRENT_JSON" | jq -r '.containers.ghost.image')"
IMAGE_TAG="${IMAGE##*:}"
CURRENT_MARKER="$(echo "$CURRENT_JSON" | jq -r '.containers.ghost.environment.REDEPLOY_MARKER // "false"')"

if [ "$CURRENT_MARKER" = "true" ]; then
  NEW_MARKER=false
else
  NEW_MARKER=true
fi

echo "== Forcing a fresh boot: image unchanged ($IMAGE_TAG), redeploy $CURRENT_MARKER -> $NEW_MARKER =="
tofu_ "apply -auto-approve -var image_tag=$IMAGE_TAG -var redeploy=$NEW_MARKER"

# Curl the Lightsail service's own URL, not the CloudFront domain: blog/*
# has a 60s-TTL cache policy, so a request through CloudFront can hit a
# cached response and say nothing about whether the new boot is actually
# healthy. public_url bypasses CloudFront entirely.
PUBLIC_URL="$(tofu_ "output -raw public_url")"
echo "== Verifying the new boot is serving (${PUBLIC_URL%/}/blog/, bypassing CloudFront's cache) =="
for i in $(seq 1 12); do
  CODE="$(curl -fsS -o /dev/null -w '%{http_code}' "${PUBLIC_URL%/}/blog/" || true)"
  if [[ "$CODE" == 2* ]]; then
    echo "OK: ${PUBLIC_URL%/}/blog/ returned $CODE"
    exit 0
  fi
  echo "  attempt $i: got '${CODE:-no response}', retrying in 10s..."
  sleep 10
done

echo "FAILED: ${PUBLIC_URL%/}/blog/ did not return 2xx within 2 minutes of the new boot." >&2
exit 1
