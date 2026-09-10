#!/usr/bin/env bash
# Switches the instance off the custom fork build (moth qadpt) and onto
# stock Ghost from the npm registry, via ghost-cli's own update path (no
# --zip/--archive — this lets ghost-cli fetch and install whatever it
# considers the current stable release itself).
#
# Context: qadpt built a custom Ghost (fork + local webfinger patch) because
# syigu (Social Web) needed isSocialWebEnabled()'s static subdirectory check
# bypassed. That plan changed — syigu will not use the custom build, so the
# patch is no longer needed and the instance can go back to a stock,
# Ghost-CLI-managed install like any standard deployment.
#
# Requires the scoped sudoers rule from phase1/scripts/ssm-install-ghost-cli-sudoers.sh
# to already be installed (ghost update shells out to sudo internally).
#
# ALWAYS run phase1/scripts/ssm-backup-instance.sh first — this changes the
# software on a running production instance.
#
# Rollback: ghost-cli keeps the previous version directory
# (/var/www/ghost/versions/6.57.1-local.2) after this update; use
# `ghost rollback` (as ghostadmin) or phase1/scripts/ssm-rollback-ghost.sh
# <version> if the mainstream version misbehaves.
#
# Usage: phase1/scripts/ssm-switch-to-mainstream-ghost.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_ROOT/phase1/scripts/ssm-scp.sh" --lib

echo "Current version on instance..."
run_command "sudo -u ghostadmin -H bash -lc 'cd /var/www/ghost && ghost --version' 2>&1"

echo "Running stock 'ghost update --force' (pulls latest from npm registry) as ghostadmin..."
run_command "sudo -u ghostadmin -H bash -lc 'cd /var/www/ghost && ghost update --force' 2>&1"

echo "Verifying deployed version..."
run_command "sudo -u ghostadmin -H bash -lc 'cd /var/www/ghost && ghost --version' 2>&1; cat /var/www/ghost/current/package.json | grep -m1 version"

echo "Checking site responds..."
run_command "curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:8000/blog/"
