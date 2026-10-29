#!/usr/bin/env bash
# One-time: seed Phase 3's OpenTofu state with a copy of Phase 2's, so that the
# copied configuration in phase3/iac starts with an EMPTY plan, and later changes
# (flags on and off, new resources) show up as a plain diff.
#
# Reads Phase 2's remote state and writes Phase 3's remote state (a separate
# key in the same state bucket). It does not change any infrastructure.
# Refuses to overwrite a Phase 3 state that already holds resources (same
# principle as the sqlite-s3 seeding tool).
#
# Needs phase2/iac/backend.hcl and phase3/iac/backend.hcl (both gitignored).
# Usage: phase3/scripts/adopt-phase2-state.sh
set -euo pipefail

if ! command -v tofu >/dev/null || ! command -v jq >/dev/null; then
  exec nix-shell -p opentofu jq --run "$0"
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"

echo "== reading Phase 2 state"
(cd "$ROOT/phase2/iac" && tofu init -backend-config=backend.hcl -input=false >/dev/null)
(cd "$ROOT/phase2/iac" && tofu state pull) >"$TMP/state.json"
jq -e '.resources | length > 0' "$TMP/state.json" >/dev/null ||
  { echo "Phase 2 state is empty; nothing to adopt" >&2; exit 1; }

echo "== preparing Phase 3 backend"
cd "$ROOT/phase3/iac"
tofu init -backend-config=backend.hcl -input=false >/dev/null
if [ -n "$(tofu state list 2>/dev/null || true)" ]; then
  echo "Phase 3 state already holds resources; refusing to overwrite" >&2
  exit 1
fi

echo "== pushing the copy to Phase 3 state"
tofu state push "$TMP/state.json"

echo "== plan (expected: no changes)"
IMAGE="$(tofu show -json | jq -r '[.values.root_module.resources[]
  | select(.type == "aws_lightsail_container_service_deployment_version")
  | .values.container[0].image][0] // empty')"
TAG="${IMAGE##*:}"
[ -n "$TAG" ] || { echo "could not read the deployed image tag; set -var image_tag manually" >&2; exit 1; }

set +e
tofu plan -input=false -detailed-exitcode -var "image_tag=$TAG"
RC=$?
set -e
case "$RC" in
  0) echo "OK: empty plan, Phase 3 state matches live infrastructure" ;;
  2) echo "NOT EMPTY: review the diff above before changing anything" >&2; exit 2 ;;
  *) echo "plan failed" >&2; exit "$RC" ;;
esac
