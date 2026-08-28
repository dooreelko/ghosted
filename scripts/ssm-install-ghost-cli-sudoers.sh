#!/usr/bin/env bash
# Installs a scoped NOPASSWD sudoers rule for ghostadmin, needed for `ghost
# update`/`ghost install` to run non-interactively over SSM (no TTY exists
# to answer sudo's password prompt). Scoped to exactly what ghost-cli's own
# source shells out for (grep 'ui.sudo' across
# /usr/lib/node_modules/ghost-cli/lib/ on the instance): running arbitrary
# commands as the `ghost` service user (theme symlink/rm, DB migrator), plus
# a handful of specific root-level binaries for content-directory
# backup/ownership management (chown, mkdir, cp, rm, ln, useradd), plus the
# exact systemctl invocations ghost-cli's systemd extension makes (start/
# stop/restart/is-active/is-enabled/enable/disable/reset-failed on the
# ghost service, plus a bare daemon-reload) — found by grepping
# extensions/systemd/*.js on the instance after a first deploy attempt
# failed on `sudo systemctl is-active ...` (not a password problem: any
# sudo call outside this allowlist makes ghost-cli try to prompt
# interactively for a password, which throws under SSM's non-TTY session).
# Command arguments within the chown/mkdir/etc binaries are not further
# restricted — ghost-cli's own paths are version-dependent, so a tighter
# allowlist there would break on every update.
#
# The remote install script validates with `visudo -c` before writing
# anything to /etc/sudoers.d/ — a malformed rule fails safely, nothing is
# installed.
#
# Usage: scripts/ssm-install-ghost-cli-sudoers.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_ROOT/scripts/ssm-scp.sh" --lib

SYSTEMD_UNIT="ghost_the-well-architected-cloud-com"

SUDOERS_CONTENT="$(cat <<EOF
ghostadmin ALL=(ghost) NOPASSWD: ALL
ghostadmin ALL=(root) NOPASSWD: /usr/bin/chown, /usr/bin/mkdir, /usr/bin/cp, /usr/bin/rm, /usr/bin/ln, /usr/sbin/useradd
ghostadmin ALL=(root) NOPASSWD: /usr/bin/systemctl daemon-reload
ghostadmin ALL=(root) NOPASSWD: /usr/bin/systemctl start ${SYSTEMD_UNIT}
ghostadmin ALL=(root) NOPASSWD: /usr/bin/systemctl stop ${SYSTEMD_UNIT}
ghostadmin ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${SYSTEMD_UNIT}
ghostadmin ALL=(root) NOPASSWD: /usr/bin/systemctl is-active ${SYSTEMD_UNIT}
ghostadmin ALL=(root) NOPASSWD: /usr/bin/systemctl is-enabled ${SYSTEMD_UNIT}
ghostadmin ALL=(root) NOPASSWD: /usr/bin/systemctl enable ${SYSTEMD_UNIT} --quiet
ghostadmin ALL=(root) NOPASSWD: /usr/bin/systemctl disable ${SYSTEMD_UNIT} --quiet
ghostadmin ALL=(root) NOPASSWD: /usr/bin/systemctl reset-failed ${SYSTEMD_UNIT}
EOF
)"
B64="$(printf '%s\n' "$SUDOERS_CONTENT" | base64 -w0)"

REMOTE_SCRIPT="printf %s ${B64} | base64 -d > /tmp/ghostadmin-ghost-cli-sudoers && visudo -c -f /tmp/ghostadmin-ghost-cli-sudoers && install -m 0440 -o root -g root /tmp/ghostadmin-ghost-cli-sudoers /etc/sudoers.d/ghostadmin-ghost-cli && visudo -c && echo INSTALLED: && cat /etc/sudoers.d/ghostadmin-ghost-cli"

echo "Installing scoped sudoers rule for ghostadmin..."
run_command "$REMOTE_SCRIPT"
