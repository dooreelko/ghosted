empty-store.sh deletes segments/ and root.json but not leases/. After a
re-seed, any stale lease objects would reference segment ids that no
longer exist in the new store, and would suppress reclamation of the new
store's genuine orphans until they expire. Benign today (5-minute TTL, and
leases/ is empty live), but inconsistent with what "empties the store" is
supposed to mean.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: also clear leases/ (or explicitly document why it's
deliberately left alone, if that's the intent).
