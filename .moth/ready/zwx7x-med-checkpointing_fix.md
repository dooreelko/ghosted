performCheckpoint (phase2/packages/sqlite-s3/src/checkpoint.js:26-48) reads the manifest, merges every segment into a new 3.4MB base, writes it, then compare-and-swaps the manifest — and on conflict abandons the attempt, leaving the base behind. It's kicked off fire-and-forget from the commit path, so it races its own process's next commit and loses every time. Nothing ever deletes the loser.

this task blocks i8hlt


----- AI agent updates -------

## Evidence from production (2026-09-10)

Measured on the live store after roughly sixteen hours of an otherwise idle
site, which is the only reason this surfaced at all — it is invisible in any
short run.

- 941 segments, 579 MB total, for a database of about 3.4 MB.
- 170 full-size base segments were written; **169 of them are unreferenced**
  — 572.5 MB of garbage. The manifest still named the base written at
  seeding time, a day earlier.
- 771 WAL segments accumulated, none ever removed, all still referenced.
- 169 of the 170 base writes landed within 90 seconds of a WAL commit,
  which is what identifies the race rather than merely suggesting it.

Two costs, both compounding, and they feed each other: storage grows at
roughly 34 MB/hour regardless of traffic, and every boot must fetch the base
plus every WAL segment, so restore time grows without bound — which lengthens
the merge, which widens the very race that caused it.

Nothing is corrupted: readers reconstruct correct state throughout, and the
migration's own validation passed against this store. It is a liveness and
cost defect, not a correctness one.

## What the fix has to achieve

**A checkpoint must eventually land, under continuous single-process
writes.** The present design can only succeed if no commit occurs during the
merge, and the merge is precisely the operation that grows with every commit
that does. Any fix that leaves "win an uncontended window" as the success
condition will fail the same way, more slowly.

**Losing a race must not leak.** Whatever a failed attempt wrote must be
removed or reused, not abandoned. Today's failure path is silent and costs
3.4 MB per occurrence.

**Superseded segments must be reclaimed.** Even with checkpointing working,
segments folded into a new base are dead the moment the manifest advances,
and nothing deletes them. Reclamation must be safe against readers that are
mid-restore from the manifest they last read.

**The remedy must not reintroduce the concurrency the store was designed
for.** Multiple writers were an explicit design point of the underlying
store; serialising everything through a single lock would trade this defect
for a worse one.

Suggested direction, not yet a decision: retry the compare-and-swap by
folding in only the segments that landed during the merge, rather than
discarding the merged result and starting over. That converges as long as
progress outpaces arrivals, and reuses the expensive work instead of
throwing it away.

## Constraints

- The store is now serving production; the site was cut over on 2026-09-10
  (see `i8hlt`). A fix has to be deployable without a further content
  migration, and must be safe against a store already holding a large
  orphaned backlog.
- The existing backlog needs a one-time reclamation, separate from the
  ongoing fix.
- Reproduce the race in a test before fixing it. It is a timing defect that
  a single-shot test will not see; the test needs continuous writes across
  a merge that is slow relative to them.
