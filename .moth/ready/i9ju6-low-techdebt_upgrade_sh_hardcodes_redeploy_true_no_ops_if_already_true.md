variables.tf correctly documents redeploy as a toggle: "Each transition
(false->true or true->false) forces one restart." upgrade.sh's recovery
path hardcodes -var redeploy=true. If live state is already true (e.g. a
prior upgrade recovery, or a manual metrics-refresh that was never flipped
back), the container definition doesn't change on this apply, no restart
is forced, and the just-restored store is never actually loaded into the
container -- while the subsequent verify.mjs may still pass off the old
container's already-running local DB file, reporting a successful restore
that didn't actually happen.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: read the current value of redeploy from state first and
flip to its opposite, rather than hardcoding true.
