#!/usr/bin/env bash
# One-off fix for a pre-existing permission quirk on the instance (present
# since the original install, unrelated to the build-pipeline patch):
# `ghost update`'s pre-flight doctor check refuses to proceed because some
# default theme asset files aren't group-writable. Ghost-CLI's own error
# message suggests exactly this fix; scoped to /var/www/ghost, excluding
# versions/ (prior release snapshots) and .pnpm-store/ per its own
# suggested command.
#
# Usage: phase1/scripts/ssm-fix-theme-permissions.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_ROOT/phase1/scripts/ssm-scp.sh" --lib

echo "Fixing file permissions under /var/www/ghost (excluding versions/, .pnpm-store/)..."
run_command "find /var/www/ghost -not -path '*/versions/*' -not -path '*/.pnpm-store/*' -type f -exec chmod 664 {} \\; ; echo DONE"
