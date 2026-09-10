preload.mjs calls reclaimOrphanedSegments({dryRun: true}) under a comment
reading "a dry run only, never deletes anything itself". But reclaim.js's
reclaimExpiredLeases runs BEFORE the dryRun check and unconditionally
objectStore.delete()s every expired lease. Harmless today (sweeping
expired leases is desirable, and leases/ is empty live), but the comment
is false, and deorphan.sh without --execute also deletes lease objects --
not what "dry run" promises an operator reading the script.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: either gate reclaimExpiredLeases on dryRun too, or fix the
comment/naming to be honest that expired-lease cleanup always happens
regardless of dryRun.
