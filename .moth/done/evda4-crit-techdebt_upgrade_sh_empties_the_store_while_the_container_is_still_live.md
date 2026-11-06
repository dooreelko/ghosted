`phase2/scripts/upgrade.sh`'s failure-recovery path (empty-store.sh --yes,
then seed-from-sqlite.mjs) never stops or disables the Lightsail service
first. The rolled-back Ghost container keeps serving and writing throughout.

Concrete failure: the live container's commit path can recreate root.json
between the empty and the seed. seedStoreFromSqliteFile then throws
"refusing to seed: this store is already seeded", set -e kills the script,
and the result is an emptied store, no backup restored, and a live broken
site -- the worst possible outcome, and the script's own "do not delete
$BACKUP_PATH" message is never reached.

Even absent that race, any write accepted by the old container between the
empty and the forced restart is silently lost.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.
Never exercised for real (would require forcing an actual failing upgrade
against production).

Fix direction: disable/scale the Lightsail service (or otherwise stop
accepting writes) before the empty+reseed, and confirm no writer is active
before proceeding.
