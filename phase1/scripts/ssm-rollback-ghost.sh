#!/usr/bin/env bash
# Emergency manual rollback: repoints /var/www/ghost/current back to a
# known-good version directory and restarts the service. Used when
# ghost-cli's own automatic rollback fails partway (as happened here — its
# DB migration rollback step errored, leaving current pointed at a broken
# build while the service was down).
#
# Does NOT touch the database — only the version symlink and the service.
# Safe to run repeatedly; a no-op restart if already on the target version.
#
# Usage: phase1/scripts/ssm-rollback-ghost.sh <version>
#   e.g. phase1/scripts/ssm-rollback-ghost.sh 6.57.1

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_ROOT/phase1/scripts/ssm-scp.sh" --lib

VERSION="${1:?usage: $0 <version-dir-name-under-/var/www/ghost/versions>}"

echo "Confirming target version directory exists..."
run_command "test -d /var/www/ghost/versions/$VERSION && echo EXISTS || echo MISSING"

echo "Repointing current symlink and restarting..."
run_command "sudo -u ghostadmin -H bash -lc 'cd /var/www/ghost && ln -sfn /var/www/ghost/versions/$VERSION /var/www/ghost/current' && sudo systemctl reset-failed ghost_the-well-architected-cloud-com && sudo systemctl start ghost_the-well-architected-cloud-com && sleep 3 && sudo systemctl is-active ghost_the-well-architected-cloud-com"

echo "Checking site health..."
run_command "curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:2368/blog/ || curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:2368/"
