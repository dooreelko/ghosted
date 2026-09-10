# Checkpoint race fix — design

Moth: zwx7x

## Problem

`performCheckpoint` (`phase2/packages/sqlite-s3/src/checkpoint.js`) merges the
full WAL into a new base segment, then CASes the manifest. On conflict it
abandons the attempt and leaves the merged base behind. It's fired
fire-and-forget from the commit path, so under continuous single-process
writes it races its own process's next commit and reliably loses. Nothing
ever deletes the loser.

Production evidence (2026-09-10, ~16h idle site): 941 segments / 579MB for a
3.4MB DB; 169 of 170 base writes unreferenced (572.5MB garbage); 169/170
landed within 90s of a WAL commit, confirming the race. No corruption —
readers reconstruct correct state — but storage grows ~34MB/hour regardless
of traffic, and boot/restore time grows unbounded with it.

## Requirements

- A checkpoint must eventually land under continuous single-process writes.
  "Win an uncontended window" cannot be the success condition.
- A losing attempt must not leak its merged segment.
- Segments superseded by a winning checkpoint must be reclaimed, safely
  against a reader mid-restore from the manifest generation being
  superseded.
- No reintroduction of the concurrency the store's multi-writer design
  depends on (no global lock).
- Deployable without a further content migration; safe against a store
  already holding a large orphaned backlog.
- The existing backlog needs a one-time reclamation, separate from the
  ongoing fix.
- The race must be reproduced in a test before being fixed (timing defect;
  needs continuous writes across a merge slower than them).

## Design

### 1. Bounded retry with incremental fold

`performCheckpoint` retries the merge-and-CAS up to a fixed cap (default 5,
configurable). On a CAS conflict, instead of discarding the merged result and
starting over, it folds only the WAL segments that landed since the merge
started onto the base it already built, and CASes again. This converges as
long as fold-and-retry outpaces new arrivals, and reuses the expensive merge
work across retries instead of throwing it away each time.

If the cap is hit, the attempt abandons cleanly (see §2). The existing
checkpoint trigger policy (`createCheckpointPolicy`) will fire again later
and retry from scratch.

### 2. Delete-on-abandon

Every retry that writes a new base segment but does not win the final CAS
deletes that segment before returning. This requires adding a `delete(key)`
operation to the object store (`object-store.js`, both the in-memory and S3
backends) and a `segmentStore.deleteSegment(id)` wrapper. No abandoned
attempt leaves a segment behind, ever.

### 3. Reader leases

The race for reclamation is narrower than general concurrent reads: the
store has one active writer at a time, and `restoreLocalDb` runs once per
process boot (chiefly during deploy rollover, when an old and new process
instance can briefly overlap). The unsafe case is: a booting process reads
the manifest (a pre-checkpoint generation) and starts fetching its segments
just as a concurrent checkpoint's CAS wins and reclaims those same segments.

Before calling `buildMergedFileBytes`, `restoreLocalDb` writes a lease object
(`leases/<uuid>`) recording the manifest generation (etag) it's restoring
from and an expiry, refreshing it if the restore runs long, and deleting it
when restore completes. This needs `list(prefix)` added to the object store
alongside `delete`.

### 4. Inline reclamation, lease-gated

The same `performCheckpoint` call that wins the CAS deletes the old
`baseSegmentId` and the WAL segment ids just folded into the new base —
gated by the lease check: list current `leases/*`, drop any past their TTL
(default: 2x the expected worst-case boot time) as stale/crashed, and skip
deleting a segment if any live lease still references the pre-checkpoint
generation it belongs to. A skipped reclamation is retried by the next
successful checkpoint, not retried immediately.

### 5. One-time backlog cleanup

A standalone script (not run directly against production by the agent — per
repo convention, packaged for the user to run) that lists all
`segments/*`, computes the set reachable from the current manifest, and
deletes everything else, reusing the same lease-safety check from §4. Run
once against the live store to clear the existing ~572MB backlog.

### 6. Test: reproducing the race

Add a test-only seam to `buildMergedFileBytes` (e.g. an optional callback
invoked once the base merge is built, before it's returned) so a test can
pause mid-merge deterministically, drive a real `commitWalDelta` through
`createCommitter` to land a genuine competing commit, then let the merge
resume. Assert: the checkpoint retries with the incremental fold, wins, and
no segment is deleted early or leaked.

## Out of scope

- General multi-reader concurrency beyond boot-time restore overlap.
- Changing the commit path's own conflict/rebase logic (`commit.js`) —
  already correct per its existing comments.
- Any change to segment/WAL wire format.
