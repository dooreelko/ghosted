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
detection with retry. This design ports that shape to Node, but reuses
SQLite's own WAL mechanism as the segment source instead of building a
parallel page-log — WAL frames already carry page numbers, which is
exactly the write-set data optimistic conflict detection needs.

## Storage model

Three S3 object kinds, mirroring the Python original:

- **Base segment** — a full `.db` file snapshot, msgpack-wrapped
  (metadata + raw bytes payload), stored at `segments/{uuid}.seg`.
  Created at each checkpoint.
- **WAL segments** — the WAL frames appended by one committed
  transaction, msgpack-wrapped, stored at `segments/{uuid}.seg`.
  Frame headers include page numbers, which serve as that segment's
  write-set with no extra bookkeeping.
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
   frames — this transaction's write-set is the set of page numbers in
   those frames.
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

## Startup

Before Ghost/Knex opens the database connection: pull the base segment
and every WAL segment referenced by the current manifest, reconstruct
local `<db>` and `<db>-wal` files from them, and let SQLite's own WAL
recovery do the rest. No custom recovery logic — this is exactly what
SQLite already does when a process opens a DB with a pending WAL.

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

## Smoke test

- A throwaway S3 bucket, created via `aws cli` (not OpenTofu — this is
  disposable, not part of the standing IaC).
- docker-compose running the forked Ghost image plus this package,
  configured against that bucket.
- Verify: write survives a container restart (base+WAL segment
  round-trip); a basic concurrent-writer conflict scenario (two writers
  committing overlapping pages) exercises the rebase/retry path if
  feasible to simulate locally.

## Out of scope

- Actual Lightsail/OpenTofu deployment wiring — covered by `hnj9a`.
- Real-environment validation against the deployed setup, migration
  cutover — covered by `i8hlt`.
- Any multi-region or cross-account S3 concerns — single bucket, single
  region, per `hi3zi`.
