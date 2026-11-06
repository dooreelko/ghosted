#!/usr/bin/env bash
# Plan and apply the Phase 3 functions stage: the queue, the functions (roles, log
# groups, and their code from the built package), the HTTP API with its routes and
# the alarms. OpenTofu owns the code too: build the package first
# (phase3/scripts/build-functions.sh, NODE_MAJOR matching node_runtime), then the
# plan shows a change exactly when the build changed.
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
