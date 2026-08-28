#!/usr/bin/env bash
# Deploys a Ghost archive tarball already sitting on the instance via
# ghost-cli's --zip (--archive) install path, run as ghostadmin (the
# Ghost-CLI-managed install's owner — running ghost-cli as root is
# explicitly refused by ghost-cli itself). Requires the scoped sudoers
# rule from scripts/ssm-install-ghost-cli-sudoers.sh to already be
# installed, since `ghost update` shells out to sudo internally (content
# backup, and critically running the DB migrator as the `ghost` user).
#
# Usage: scripts/ssm-deploy-ghost-update.sh /tmp/ghost-<version>.tgz
#   (the path as it exists ON THE INSTANCE, already pushed there —
#   see scripts/ssm-scp.sh push)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_ROOT/scripts/ssm-scp.sh" --lib

REMOTE_TGZ="${1:?usage: $0 <remote-tarball-path>}"

echo "Confirming tarball exists on the instance..."
run_command "ls -la '$REMOTE_TGZ' && sha256sum '$REMOTE_TGZ'"

echo "Running ghost update --zip $REMOTE_TGZ --force as ghostadmin..."
run_command "sudo -u ghostadmin -H bash -lc 'cd /var/www/ghost && ghost update --zip $REMOTE_TGZ --force' 2>&1"

echo "Verifying deployed version..."
run_command "sudo -u ghostadmin -H bash -lc 'cd /var/www/ghost && ghost --version' 2>&1; cat /var/www/ghost/package.json | grep -m1 version"
