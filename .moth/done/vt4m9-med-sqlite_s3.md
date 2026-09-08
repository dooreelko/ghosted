subtask of hi3zi

we'll implement sqlite over s3 and plug it into Ghost, smoke test locally with docker

## Decisions

Full technical design in `docs/superpowers/specs/2026-09-07-sqlite-s3-design.md`;
this entry stays the decision record.

**Storage: reuse SQLite's own WAL as the segment source**, not a custom
page-log. Base `.db` snapshot + per-commit WAL-frame segments on S3
(msgpack), JSON manifest (`root.json`) pointing at
`{baseSegmentId, walSegmentIds[]}`.
- Rejected: reimplementing a generic page-level segment store from
  scratch (closer literal port of chrisk60331/distributed-sqllite) —
  WAL frames already carry page numbers, which is exactly the
  write-set data needed for conflict detection, so reusing them avoids
  building a parallel mechanism.

**Revised (post-implementation, final review):** raw WAL bytes turned out
incompatible with real multi-writer use — SQLite's WAL frame checksums
chain against that WAL file's own random header salts, so two
independently-created WAL files can never be spliced. Replaced with
page-image segments (`{pageNumber, pageBytes}`, deduped last-write-wins)
extracted from the WAL frames instead of stored as raw bytes; the
conflict-detection protocol (write-sets, CAS, rebase-or-retry) is
unchanged. See the design doc's "Revision" note for the full account.

**Manifest CAS: native S3 conditional writes** (If-Match/If-None-Match),
not a DynamoDB lock table. One S3 object is enough for a single mutable
pointer; a second AWS resource wasn't justified.

**Multi-writer, not single-writer** — explicitly not simplified away
despite this phase staying single-node for now, because Phase 2's
stated goal is to allow scaling beyond single-node later. Commit path:
snapshot at manifest version, commit locally, conditional-PUT the new
manifest; on conflict, diff write-sets (page numbers) — no overlap
rebases and retries, overlap discards and retries the whole
transaction. Up to 10 attempts, full-jitter backoff — matches the
python original's retry policy rather than inventing new numbers.

**Restore: overlay page images in manifest (causal) order, truncate to
the MAXIMUM `dbSizeAfterCommit` across every segment, not the last
one.** Truncating to the last segment's size looks right for a linear
history but corrupts the file under genuine concurrency: two commits
with disjoint write-sets can both legitimately land, and if the one
that didn't grow the db lands later in manifest order, truncating to
its smaller size discards the other's pages entirely. Reproduced
directly (clean `PRAGMA integrity_check` under max, corruption under
last). Restore produces an already-consistent file with no WAL replay
needed.

**Connection pool pinned to exactly one connection (`min:1, max:1`).**
Restore deletes and rewrites the local `.db`/`-wal`/`-shm` files on
every connection acquire; a normal multi-connection pool would let a
second connection acquire concurrently and delete the db out from
under the first. Enforced by the client itself, not left to caller
config.

**Checkpointing: size-triggered OR time-triggered, whichever first**,
with the time trigger skipped if nothing changed since the last
checkpoint (no no-op checkpoints during idle periods). Checkpointing
merges the growing wal-segment list into a new base by reusing the same
overlay logic restore uses (reflecting every writer's history, not just
the checkpointing writer's) — a naive "checkpoint from my own local
file" approach would silently drop other writers' pages. Best-effort:
abandons silently on a CAS conflict, retried next time the trigger
fires.

**Conflict reconciliation is opt-in, not automatic**
(`knex.transaction(fn, { sqliteS3Reconcile: true })`), and works by
restoring fresh state from the current manifest and **re-invoking the
caller's own callback function** — not replaying recorded SQL text.
Page-level conflicts are only knowable after SQLite has actually run
the transaction (page allocation is an internal B-tree decision), so
the third-party Python reference's approach (defer persistence, replay
buffered SQL text on conflict — safe because ITS conflict check is at
the SQL-text level, knowable ahead of running anything) doesn't apply
here; re-running the real JS callback against fresh state avoids the
staleness risk text-replay carries (e.g. `x = x + 1` computed against
the wrong snapshot). Automatic (non-opt-in) retry was rejected: Knex's
`transaction()` has a second, callback-less calling form (used by
Ghost's own `timetravel` command) that genuinely deadlocks the
connection pool if retried the same way — reproduced directly. Coverage
is therefore uneven by design: Ghost's relational models (post, user,
member, comment) self-wrap in `.transaction()` and can opt in; simpler
models (tag, label, settings, and others on the shared CRUD plugin's
defaults) commonly write autocommit with no transaction at all, and a
lost conflict race there has no safe retry — it surfaces as a clear
error instead of silently corrupting anything.

**Integration: Knex client wrapping `better-sqlite3`**, not a custom
SQLite VFS — this is the integration shape `hi3zi` left as an accepted
unresolved risk, now resolved. Package lives at
`phase2/packages/sqlite-s3/`. Ghost's own config/core is unchanged in
shape (still looks like a `sqlite3` Knex client from Ghost's side).

**Process-wide S3-config registry as a fallback**, alongside normal
per-instance config. Some hosts (observed with Ghost's `knex-migrator`)
construct additional Knex clients from an independently re-derived copy
of the connection config, which isn't reliable for carrying the S3
store objects through — a process-wide registration point set once at
boot sidesteps that regardless of how many separately-constructed
client instances end up existing.

**Smoke test: real throwaway S3 bucket via `aws cli`** (not OpenTofu —
disposable, not part of standing IaC), docker-compose running the
forked Ghost image against it. Verifies restart-survival and exercises
the multi-writer conflict/rebase path if feasible to simulate locally.

**Multi-writer e2e proof, real S3 (Cucumber, `e2e/`, opt-in via
`npm run test:e2e`)**: 3 concurrent standalone Knex clients (real
`SqliteS3Client`, no Ghost) reconcile 24 inserts into a shared table,
then a brand-new client with no local state bootstraps from the db the
first scenario left in the bucket. Caught a real correctness bug the
unit tests (in-memory object store, no meaningful race window) never
exercised: the commit path re-read the manifest fresh immediately
before its CAS attempt instead of using the writer's actual
last-known-synced baseline, so the CAS nearly always succeeded
uncontested even when the writer's local page image was stale —
silently overwriting other writers' already-landed rows with no
conflict ever raised. Fixed by threading the writer's real
`{manifest, etag}` baseline (from its last restore or last successful
commit) through explicitly, so the CAS conflicts exactly when it
should. Regression-covered at both the unit level (`test/commit.test.js`)
and the e2e level.

## Known limitations / out of scope

- **Bare autocommit writes (no `.transaction()` wrapper) have no safe
  retry on a lost conflict race** — by the time a conflict is detected
  the write already committed locally; there's no local transaction
  left to retry, and no safe way to retry a single bare statement that
  might be non-idempotent. Surfaces as an explicit error to the caller.
- **One S3 round-trip per SQL-level commit doesn't scale to
  write-heavy bursts.** Confirmed live against a real Ghost boot:
  first-ever-boot fixture insertion (~177 individual statements) can
  exceed Knex's connection-pool-acquire timeout under real S3 latency.
  A normal blog's steady-state writes never hit this. Would need either
  batching multiple statements into fewer round-trips, or capturing
  only at explicit transaction boundaries.
- **No garbage collection.** Superseded base segments and folded-in wal
  segments are never deleted from S3 — correctness is unaffected, but
  object count grows monotonically forever.
- **Checkpoint throttling is per-connection-instance, not fully shared
  across `knex.transaction()` calls**, because Knex clones the client
  internally for transaction queries. Weakens throttling precision
  under heavy transactional contention; does not cause data loss (S3's
  own CAS still arbitrates concurrent checkpoint attempts safely).
- **The process-wide S3-config registry is a one-way latch with no
  per-instance scoping.** A process running multiple `SqliteS3Client`
  instances with genuinely different S3 configs would have the first
  instance's config silently win as the fallback for every other
  instance's transaction clones. Not exercised by Ghost's actual
  deployment shape (one database per process).
- Actual Lightsail/OpenTofu deployment wiring — covered by `hnj9a`.
- Real-environment validation against the deployed setup, migration
  cutover — covered by `i8hlt`.
- Any multi-region or cross-account S3 concerns — single bucket, single
  region, per `hi3zi`.
