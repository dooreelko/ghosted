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

## Design decided (2026-09-10)

Full design: `docs/superpowers/specs/2026-09-10-checkpoint-race-fix-design.md`

- Bounded retry (cap ~5), each retry folds only newly-landed WAL segments
  onto the already-built base instead of re-merging from scratch.
- Cap exhausted → abandon cleanly, deleting the base segment this attempt
  wrote. No leak.
- Superseded segments reclaimed inline by the winning checkpoint call,
  gated by reader leases (TTL'd lease objects written by `restoreLocalDb`
  around its manifest read + segment fetch) so a boot mid-restore from a
  pre-checkpoint generation can't have its segments pulled out from under
  it.
- Existing 572MB backlog: separate one-time script, reusing the same
  lease-safety check, packaged for the user to run — not executed directly
  against production by the agent.
- Race reproduced via a test-only seam in `buildMergedFileBytes` that pauses
  mid-merge so a real concurrent commit can land before the merge resumes.
- Needs `delete` and `list` added to the object store (S3 + in-memory
  backends) — neither exists today.

## Implemented (2026-09-10)

Branch `zwx7x-checkpoint-race-fix` (off `main`). Plan:
`docs/superpowers/plans/2026-09-10-checkpoint-race-fix.md`, executed task by
task with review at each step, then a final whole-branch review.

The final review caught two Critical gaps the per-task reviews structurally
couldn't see: three in-repo production/smoke/doc config sites
(`ghost-sqlite-s3-launcher/src/preload.mjs`, `sqlite-s3/smoke/preload.mjs`,
`sqlite-s3/README.md`) were never wired with the new required `leaseStore`
and would have broken every real Ghost boot; and the one-time backlog
script read the manifest before listing segments, which could delete a
concurrent checkpoint's brand-new winning base. Both fixed, plus a handful
of smaller findings (dead parameter, a leak on non-conflict CAS errors, an
unsafe try-scope that could mask a landed checkpoint as failed, expired
lease objects never being swept). Re-reviewed clean.

One gap was deliberately parked at the time rather than fixed in that pass:
`restoreLocalDb`'s manifest read (done by the caller, `knex-client.js`) and
its own lease acquisition are two separate round trips, so a concurrent
checkpoint's reclamation could still land in that narrow window and delete
segments a boot is about to fetch. Decided afterward to close it rather than
leave it live: `restoreLocalDb` now retries (bounded, default 3 attempts) by
re-reading the manifest whenever a fetch hits exactly that race, instead of
failing the boot outright.

Still open / deliberately not done: `lease.refresh()` exists and is tested
but nothing calls it — restore relies on a fixed 5-minute TTL, which is fine
at the current ~3.4MB database size but would need wiring up if the backlog
ever grows large again before a restore completes. Not fixed now; revisit if
that changes.

Merge/deploy is separate from this task — not done yet.
