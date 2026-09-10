deploy.sh resolves REPO_ROOT via
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)", unlike upgrade.sh
and deorphan.sh, which both resolve through readlink -f first (fixed
earlier this session after deorphan.sh broke when invoked via a symlink at
a different directory depth). deploy.sh has the same latent bug: invoked
through a symlink, it computes the wrong repo root.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: apply the same readlink -f "${BASH_SOURCE[0]}" fix to
deploy.sh's REPO_ROOT line.
