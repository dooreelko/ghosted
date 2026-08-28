#!/usr/bin/env bash
# Copies the admin UI build (core/built/admin) from one deployed Ghost
# version directory to another, entirely on the instance (no network
# transfer). Needed because our custom build/pack pipeline doesn't build
# admin (a Vite/Ember app, built separately in real Ghost CI and not part
# of this backend-only patch) - admin is static files served on demand,
# not required for Ghost to boot, so this can safely run as a follow-up
# after `ghost update` succeeds rather than being bundled into the deploy.
#
# Usage: scripts/ssm-copy-admin-build.sh <from-version> <to-version>
#   e.g. scripts/ssm-copy-admin-build.sh 6.57.1 6.57.1-local.2

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_ROOT/scripts/ssm-scp.sh" --lib

FROM="${1:?usage: $0 <from-version> <to-version>}"
TO="${2:?usage: $0 <from-version> <to-version>}"

echo "Copying core/built/admin: $FROM -> $TO"
run_command "sudo -u ghostadmin bash -c 'cp -r /var/www/ghost/versions/$FROM/core/built/admin /var/www/ghost/versions/$TO/core/built/admin' && ls /var/www/ghost/versions/$TO/core/built/admin | head -5"
