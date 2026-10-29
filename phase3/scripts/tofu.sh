#!/usr/bin/env bash
# Run OpenTofu in phase3/iac with the deployed container image tag filled in,
# as the configuration requires while the container flag is on.
# Usage: phase3/scripts/tofu.sh plan|apply [extra tofu arguments]
set -euo pipefail

if ! command -v tofu >/dev/null || ! command -v jq >/dev/null; then
  exec nix-shell -p opentofu jq --run "$0 $*"
fi

cd "$(cd "$(dirname "$0")/../.." && pwd)/phase3/iac"
tofu init -backend-config=backend.hcl -input=false >/dev/null

IMAGE="$(tofu show -json | jq -r '[.values.root_module.resources[]?
  | select(.type == "aws_lightsail_container_service_deployment_version")
  | .values.container[0].image][0] // empty')"
TAG="${IMAGE##*:}"
ARGS=()
[ -n "$TAG" ] && ARGS=(-var "image_tag=$TAG")

exec tofu "$1" "${ARGS[@]}" "${@:2}"
