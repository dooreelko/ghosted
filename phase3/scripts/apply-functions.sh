#!/usr/bin/env bash
# Stage 1 of the Phase 3 deploy: create the queue, the 16 placeholder functions
# (roles, log groups), the HTTP API with its routes and the alarms. Changes
# nothing that serves traffic today: the distribution is not touched, the
# schedules stay disabled, and the functions answer 501 until real code is
# deployed.
#
# Needs phase3/iac/backend.hcl and the gitignored tfvars (see .local-secrets.md).
# Usage: phase3/scripts/apply-functions.sh [image_tag]
set -euo pipefail

cd "$(dirname "$0")/../iac"
TAG="${1:-11e38b5}"
tofu init -backend-config=backend.hcl -input=false >/dev/null
tofu plan -var "image_tag=$TAG" -var deploy_functions=true -out=tfplan
read -r -p "Apply this plan? [y/N] " ans
[ "$ans" = y ] || { echo "not applied"; exit 1; }
tofu apply tfplan
rm -f tfplan
tofu output api_endpoint
