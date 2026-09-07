# SQLite-over-S3 design (moth vt4m9)

Technical design for the S3-backed SQLite storage layer decided at a
high level in moth `hi3zi` (Phase 2). This doc covers the integration
shape that decision left open: exact storage format, commit/conflict
protocol, checkpointing, and where the code lives.

## Context

Ghost talks to its database through Knex using the `sqlite3` client
config shape (`database__client: sqlite3`,
`database__connection__filename: <path>`) — confirmed via
`Ghost/compose.dev.sqlite.yaml`, which sets exactly this for local dev.
Lightsail Containers have no persistent-volume option, so the `.db`
file cannot simply live on disk across restarts/redeploys; it must be
backed by S3 without giving up multi-writer correctness (the Phase 2
goal explicitly allows scaling beyond single-node later) or forcing
downtime on every normal restart (only the one-time VM migration
accepts downtime, per `hi3zi`).

The third-party reference, [chrisk60331/distributed-sqllite](https://github.com/chrisk60331/distributed-sqllite)
(Python), was investigated and confirmed to wrap a real local SQLite
engine rather than reimplement SQL execution: it uses "WAL-like
semantics," immutable msgpack segments on S3, JSON versioned manifests
with CAS commits, and optimistic write-set-intersection conflict
detection with retry. It achieves multi-writer composability by
reimplementing its own page-level storage format from scratch — it
does not store literal SQLite WAL bytes.

**Revision (post-implementation, final review):** the first version of
this design instead reused SQLite's own on-disk WAL bytes directly as
the segment payload, to avoid reimplementing a page-log. That shortcut
was found to be incompatible with real multi-writer use: SQLite's WAL
frame checksums form a running chain keyed to that specific WAL file's
own randomly-generated header salts, so two independently-created WAL
files can never be spliced together — SQLite's recovery code rejects
the seam, silently dropping every commit from whichever writer's
segment lands second. The conflict-detection logic below (write-sets,
CAS, rebase-or-retry) was and remains sound; only the segment
*encoding* has changed, to the page-image approach described below,
which composes across writers the way the Python original's own
reimplemented format does.

## Storage model

Three S3 object kinds, mirroring the Python original:

- **Base segment** — a full `.db` file snapshot, msgpack-wrapped
  (metadata + raw bytes payload), stored at `segments/{uuid}.seg`.
  Created at each checkpoint.
- **WAL segments** — not raw WAL bytes (see Revision above). Each
  segment holds the *page images* touched by one committed
  transaction: an ordered list of `{pageNumber, pageBytes}`, extracted
  from that transaction's WAL frames and deduped to last-write-wins per
  page (a transaction can touch the same page more than once; only its
  final version matters). Page numbers, needed with no extra bytes
  fetched, still serve as the segment's write-set for conflict
  detection — now even more directly, since they're the segment's own
  keys rather than something parsed out of raw frame headers.
- **Manifest** — `root.json`, JSON, holds
  `{ baseSegmentId, walSegmentIds: [...] }` (ordered). This is the
  single mutable pointer; everything it references is immutable.

## Manifest CAS

Manifest updates use native S3 conditional writes: `If-Match` on the
current object's ETag for updates, `If-None-Match: *` for the very
first write. No DynamoDB lock table — S3 conditional writes are
sufficient for a single-object CAS pointer and avoid a second AWS
resource.

## Commit path (multi-writer)

1. Writer opens a transaction against a local reconstruction of the DB
   at manifest version `V` (its snapshot).
2. Transaction commits locally in the normal SQLite way, producing WAL
   frames. The writer trims these to end at the last frame belonging to
   an actually-committed transaction (SQLite marks this via a nonzero
   `dbSizeAfterCommit` field on that frame) — this discards any
   orphaned frames a rolled-back transaction may have spilled into the
   WAL file, so those are never mistaken for durable data. It then
   extracts page images from the surviving frames, deduped to
   last-write-wins per page; this transaction's write-set is the set of
   page numbers in that list.
3. Writer attempts a conditional PUT of a new manifest
   `V' = V + [newSegmentId]`, conditioned on the manifest's ETag still
   matching what it read at step 1.
4. **Success** (ETag unchanged): done, segment is durable and visible.
5. **Conflict** (ETag changed — another writer landed a segment first):
   fetch the new segment(s), extract their write-set (page numbers),
   and diff against this transaction's write-set.
   - **No overlap**: safe to rebase — retry the conditional PUT against
     the new manifest version with the same local segment.
   - **Overlap**: the local commit is invalid (it was computed against
     a base that a conflicting write has since changed). Discard it,
     restart the whole transaction from the new base, and retry.
6. Retry budget: up to 10 attempts, full-jitter backoff — matches the
   Python original's policy exactly, not reinvented.

## Checkpointing

A new base segment is created when *either* condition is met:

- **Size-triggered**: accumulated WAL segments since the last base
  exceed a configurable size threshold.
- **Time-triggered**: a configurable interval has elapsed — but only if
  at least one new WAL segment has landed since the last checkpoint
  (idle periods never produce a no-op checkpoint).

Checkpointing bounds startup replay time regardless of write pattern
(bursty or idle).

**Implementation (added after the page-image redesign):** checkpointing
was originally left unwired because a naive implementation — one
writer's local file, WAL-checkpointed and re-uploaded as the new base —
would silently drop other writers' already-committed pages its own
local file never received. The page-image redesign's restore logic
(base + overlay every wal segment's page images, in manifest order,
truncated to the max `dbSizeAfterCommit`) already solves exactly this
problem for restoring a fresh connection; checkpointing reuses the same
merge logic rather than a writer's own local state. Concretely: read
the current manifest and its ETag, build the merged file bytes the same
way a restore would (this reflects every writer's history, not just the
checkpointing writer's), upload that as a new base segment, then
conditionally-PUT a manifest pointing at `{baseSegmentId: <new base>,
walSegmentIds: []}` against the ETag read at the start. On conflict
(another writer landed a new segment mid-merge) the checkpoint attempt
is simply abandoned — it is a best-effort optimization, not a
correctness-critical operation, and will be retried the next time the
trigger policy fires.

## Startup

Before Ghost/Knex opens the database connection: pull the base segment
and every WAL segment referenced by the current manifest. Start from
the base segment's raw bytes as the `<db>` file, then replay each WAL
segment in manifest order, writing each page image directly to its
byte offset (`(pageNumber - 1) × pageSize`) — extending the file if a
page number falls beyond its current length. After replaying
everything, truncate the file to the **maximum** `dbSizeAfterCommit`
carried by *any* segment, not the last one.

**Correction (final review of the page-image redesign):** the first
version of this section truncated to the last segment's
`dbSizeAfterCommit`, reasoning it was "the authoritative final size."
That's only true for a linear history. Under genuine concurrent
writers, two commits with disjoint write-sets can both legitimately
land — one that grows the database (e.g. a new row forcing a new page)
and one that doesn't (e.g. updating an existing page) — and if the
non-growing commit lands later in manifest order, truncating to *its*
(smaller, stale) page count discards the growing commit's pages
entirely, producing a corrupt, unopenable database. This was
reproduced directly: two disjoint-write-set commits, both accepted by
the CAS protocol, corrupted the restored file under the last-segment
rule and passed a clean `PRAGMA integrity_check` under the max rule.
Taking the max is safe in the other direction too — a genuine `VACUUM`
shrink is not silently corrupting if ignored (SQLite trusts page 1's
own size field when the file's change counter matches, so untruncated
trailing pages are simply unused, not consulted), whereas
under-truncation is actively corrupting. The result is an
already-consistent `<db>` file with no pending WAL at all — SQLite
opens it directly, no recovery step involved.

This is what makes the design genuinely multi-writer: page images from
different writers compose by simple overlay, in the same order the CAS
protocol already established, with no per-writer format dependency to
break. (An earlier version of this section relied on SQLite's own WAL
recovery instead — see the Revision note above for why that doesn't
survive multiple independent writers.)

## Conflict reconciliation (added after the page-image redesign)

By the time a commit loses the optimistic-concurrency race (an
overlapping write landed first), the local SQLite commit has already
physically happened — `better-sqlite3` is a real synchronous embedded
engine, not a deferred-commit layer, so there is no local transaction
left to safely "retry" once that's true. Investigating the third-party
Python reference's own reconciliation mechanism (it defers all physical
persistence until after a successful CAS, so it can safely re-execute
buffered SQL text against a fresh snapshot on conflict) confirmed why
this design couldn't do the same thing directly: its conflict check is
at the SQL-text level (table names, knowable before running anything),
knowable ahead of actually running a transaction; this design's is at
the page level, only knowable *after* SQLite has actually run the
transaction, since page allocation is an internal B-tree decision. That
tension is real, not a gap to code around.

The reconciliation this design *can* offer instead: for writes made
through Knex's `knex.transaction(async trx => {...})` callback API, the
client can, on conflict, restore local state from the now-current
manifest (reusing the same restore logic as startup) and **re-invoke
the caller's own callback function** against that fresh state — not
replay recorded SQL text. This is safe against the staleness risk the
Python reference's text-replay approach carries (e.g. a relative update
like `x = x + 1` replayed against different underlying data produces a
silently wrong result): re-running the original JS callback re-reads
current values fresh each time it executes, using real bound
parameters throughout, not string-interpolated SQL.

**Retry is opt-in, not automatic** (correction after implementation
review): `knex.transaction()` has a second, callback-less calling form
— `const trx = await knex.transaction(); ...; await trx.commit();` —
used in Ghost's own codebase (e.g. its `timetravel` CLI command). Knex
implements that form by passing its own internal resolver function as
the "container," not a real user callback; retrying that form the same
way genuinely deadlocks the connection pool (reproduced directly: every
later query hangs until the pool's acquire timeout, forever — strictly
worse than the clean rejection that existed before reconciliation was
added). Distinguishing the two calling forms reliably at the point this
client's `transaction()` override runs is not possible without coupling
to Knex-internal, version-specific implementation details. The safe
choice is to make retry an explicit opt-in: a caller passes
`knex.transaction(fn, { sqliteS3Reconcile: true })` to get
reconciliation; every other call — including every existing call in
Ghost's codebase today — behaves exactly as it did before this
capability existed. Extending Ghost's own relational-model transaction
call sites to actually pass that flag is a separate, small, deliberate
change to Ghost itself, not part of this package.

**This does not cover every write.** A survey of Ghost's actual model
layer found usage is mixed: complex/relational models (post, user,
member, comment) self-wrap writes in `ghostBookshelf.transaction(fn)`
when the caller didn't supply one — these are covered. Simpler models
(tag, label, redirect, invite, settings, and others relying on the
shared CRUD plugin's default `add`/`edit`/`destroy`) commonly perform
bare, un-wrapped autocommit writes with no `.transaction()` involved at
all when the API layer doesn't pass `{transacting}` — and it typically
doesn't. A bare autocommit write that loses a conflict race still has
no safe retry path under this design; the honest error framing
(described above) is what a caller on that path sees. Extending
coverage there would need either a different mechanism (retrying the
single known statement directly — still carries the same staleness
risk for non-idempotent statements) or changes to Ghost's own model
layer to wrap more writes in `.transaction()`, which is out of scope
for this package.

## Integration point

A new package, `phase2/packages/sqlite-s3/`, implements a Knex client
that wraps `better-sqlite3`. It intercepts after each local commit to
run the commit-path protocol above, and runs the startup restore before
handing control to Ghost. Ghost's own config is unchanged in shape —
it still points at a `database__client` that behaves like `sqlite3`
from Knex's perspective; no Ghost core changes.

This is the integration shape `hi3zi` left as an accepted, unresolved
risk ("custom SQLite VFS vs. a Knex-layer shim vs. something else").
Resolved here as: a Knex-layer client wrapping `better-sqlite3`, not a
VFS.

**Connection pool must be pinned to exactly one connection.** Restore
deletes and rewrites the local `.db`/`-wal`/`-shm` files on every
connection acquire; a default multi-connection Knex pool would let a
second connection acquire concurrently and delete the database out
from under the first. The client forces `pool: { min: 1, max: 1 }`
itself rather than relying on the caller to configure it correctly.

## Smoke test

- A throwaway S3 bucket, created via `aws cli` (not OpenTofu — this is
  disposable, not part of the standing IaC).
- docker-compose running the forked Ghost image plus this package,
  configured against that bucket.
- Verify: write survives a container restart (base+WAL segment
  round-trip); a basic concurrent-writer conflict scenario (two writers
  committing overlapping pages) exercises the rebase/retry path if
  feasible to simulate locally.

## Known limitations (accepted, tracked as follow-ups)

- **Bare autocommit writes (no `knex.transaction()` wrapper) still have
  no safe retry path on a lost conflict race.** See "Conflict
  reconciliation" above — this covers Ghost's relational models but not
  its simpler ones, which write autocommit by default.
- **One S3 round-trip per SQL-level commit doesn't scale to
  write-heavy bursts.** Confirmed live against a real Ghost boot:
  Ghost's first-ever-boot fixture insertion issues roughly 177
  individual autocommit statements, each triggering a full manifest
  CAS round-trip; under real S3 latency this exceeded Knex's
  connection-pool-acquire timeout elsewhere in the boot sequence. A
  normal blog's steady-state writes (occasional posts) never hit this
  pattern, but first-boot needs either batching multiple statements
  into fewer S3 round-trips, or capturing only at explicit transaction
  boundaries rather than every autocommit statement.

## Out of scope

- Actual Lightsail/OpenTofu deployment wiring — covered by `hnj9a`.
- Real-environment validation against the deployed setup, migration
  cutover — covered by `i8hlt`.
- Any multi-region or cross-account S3 concerns — single bucket, single
  region, per `hi3zi`.
