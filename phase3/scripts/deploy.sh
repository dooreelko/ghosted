#!/usr/bin/env bash
# The Phase 3 deploy: always the whole thing. OpenTofu's defaults describe the full
# rollout (functions with their code, API, edge, schedules, alarms), so there are no
# flags to pass and no partial variants. Build the package first
# (phase3/scripts/build-functions.sh with NODE_MAJOR matching node_runtime); the plan
# shows changes exactly when the build or the IaC changed, and none otherwise.
#
# Needs phase3/iac/backend.hcl and the gitignored tfvars (see .local-secrets.md).
# Usage: phase3/scripts/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/../iac"
tofu init -backend-config=backend.hcl -input=false >/dev/null
tofu plan -input=false -out=tfplan
read -r -p "Apply this plan? [y/N] " ans
[ "$ans" = y ] || { rm -f tfplan; echo "not applied"; exit 1; }
tofu apply tfplan
rm -f tfplan
tofu output api_endpoint
