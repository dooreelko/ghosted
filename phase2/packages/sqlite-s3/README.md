# @ghost-phase2/sqlite-s3

A Knex client that makes SQLite durable against S3, for running Ghost on
compute with no persistent disk (e.g. Lightsail Containers). It's an
internal package for this repo's Phase 2 work — not published, not general-purpose.

Inspired by https://github.com/chrisk60331/distributed-sqllite

## Purpose

Lightsail Containers (and similar platforms) have no persistent volume: a
redeployed or restarted container starts with an empty filesystem. Ghost's
SQLite database can't just live on local disk. This package backs SQLite
with S3 so the database survives restarts, while supporting **multiple
concurrent writers** (not just one) — the Phase 2 goal explicitly allows
scaling beyond a single node later.

It's a drop-in Knex client, not a sidecar or a VFS: point Knex's
`client` at `SqliteS3Client` and it behaves like a normal SQLite
connection from Ghost's (or any Knex caller's) perspective.

## How it works

SQLite already writes committed changes as *pages* (fixed-size chunks of
the database file) into a write-ahead log (WAL) before they land in the
main file. This package captures those page writes after every commit,
ships them to S3 as immutable **segments**, and reconstructs the local
database from S3 on every connect — instead of relying on the local
disk to persist anything.

- **Segments** — each committed transaction's touched pages
  (`{pageNumber, bytes}`, deduped to last-write-wins), stored as
  immutable objects in S3.
- **Manifest** (`root.json`) — the single mutable pointer: a base
  snapshot's segment id plus the ordered list of wal segments since.
  Updated via S3's native conditional writes (compare-and-swap), so two
  writers racing to update it can't silently clobber each other.
- **Commit path** — a writer commits locally (real SQLite, real
  `better-sqlite3`, real bound parameters — no SQL is replayed or
  re-executed), then tries to append its segment to the manifest via
  CAS. If another writer landed first: no page overlap → rebase and
  retry; real overlap → the caller's transaction must retry from
  scratch.
- **Restore** — on every connect, download the base snapshot and every
  wal segment, overlay each page image at its file offset
  (`(pageNumber-1) × pageSize`), truncate to the correct final size.
  Produces an already-consistent database file — no WAL replay, no
  SQLite recovery step needed.
- **Checkpointing** — periodically merges the growing wal-segment list
  into a new base snapshot (reusing the same overlay logic restore
  uses, so it reflects *every* writer's history, not just one), keeping
  restore time bounded. Runs in the background after a commit; never
  blocks or fails the caller's write.
- **Conflict reconciliation** *(opt-in)* — for writes made via
  `knex.transaction(fn, { sqliteS3Reconcile: true })`, a lost conflict
  race triggers a fresh restore from S3 and a re-invocation of the
  *original callback* against current data — not a replay of stale SQL
  text, so no risk of relative updates (`x = x + 1`) silently computing
  against the wrong snapshot.

Full design rationale, including why an earlier raw-WAL-bytes approach
was replaced with page-image segments (composability across
independent writers), lives in
[`docs/superpowers/specs/2026-09-07-sqlite-s3-design.md`](../../../docs/superpowers/specs/2026-09-07-sqlite-s3-design.md).

## Getting started

```bash
cd phase2/packages/sqlite-s3
npm install
npm test
```

### Wiring it up

```js
import knexFactory from 'knex';
import {
  SqliteS3Client,
  createManifestStore,
  createSegmentStore,
  createCheckpointPolicy,
  createS3ObjectStore,
} from '@ghost-phase2/sqlite-s3';
import { S3Client } from '@aws-sdk/client-s3';

const objectStore = createS3ObjectStore({
  bucket: process.env.SQLITE_S3_BUCKET,
  client: new S3Client({ region: process.env.SQLITE_S3_REGION }),
});

const knex = knexFactory({
  client: SqliteS3Client,
  connection: {
    filename: '/tmp/ghost.db', // any local, ephemeral path
    s3: {
      manifestStore: createManifestStore(objectStore),
      segmentStore: createSegmentStore(objectStore),
      checkpointPolicy: createCheckpointPolicy({
        maxWalBytes: 50_000_000,
        maxIntervalMs: 3_600_000,
      }),
    },
  },
  useNullAsDefault: true,
});
```

If something else in the same process constructs a Knex client
independently from your own config object (Ghost's `knex-migrator`
does this) and can't see the `s3` object above, call
`registerS3Config(s3Config)` once at process startup — every
`SqliteS3Client` instance in that process shares it as a fallback.

For a real, end-to-end example against a live S3 bucket (creating a
throwaway bucket, booting Ghost, verifying restart survival), see
`smoke/`.

### Running the multi-writer e2e suite

Not run by default (`npm test` doesn't touch it) — it makes real AWS
calls: creates a throwaway bucket, runs 3 concurrent writers against
it, then empties and deletes the bucket at the end.

```bash
cd phase2/packages/sqlite-s3
npm run test:e2e
```

Requires real AWS credentials in the environment (any chain the AWS SDK
resolves) and permission to create/tag/delete S3 buckets; fails loudly
if creds are missing rather than skipping. Set `SQLITE_S3_E2E_REGION`
to change the region (defaults to `us-east-1`).

### Running the smoke test

```bash
cd phase2/packages/sqlite-s3/smoke
./create-bucket.sh <bucket-name> <region>
SQLITE_S3_BUCKET=<bucket-name> SQLITE_S3_REGION=<region> ./run-smoke-test.sh
```

## Known bugs and limitations

None of these are hidden — they're tracked in the design doc's "Known
limitations" section too. Read that first if you're about to rely on
one of these behaviors.

- **Bare autocommit writes have no safe retry on a lost conflict.**
  Reconciliation only covers `knex.transaction(fn, {sqliteS3Reconcile: true})`.
  A plain `knex('table').insert(...)` outside a transaction that loses
  a conflict race throws — by the time the conflict is detected, the
  write already committed locally, so it can't be silently retried.
  Ghost's own model layer is mixed here: post/user/member/comment
  self-wrap in transactions (can opt in), simpler models (tag, label,
  settings) commonly don't.
- **One S3 round-trip per SQL-level commit doesn't scale to
  write-heavy bursts.** Confirmed live against a real Ghost boot:
  first-ever-boot fixture insertion (~177 individual statements) can
  exceed Knex's connection-pool-acquire timeout under real S3 latency.
  A normal blog's steady-state writes never hit this pattern.
- **No garbage collection.** Superseded base segments and folded-in wal
  segments (from checkpointing) are never deleted from S3. Correctness
  is unaffected (everything referenced stays immutable and reachable),
  but object count grows monotonically forever.
- **Checkpoint throttling is per-client-instance, not fully shared
  across `knex.transaction()` calls.** Knex creates a constructor-less
  clone internally to run transaction queries, so the in-flight guard
  and cooldown that prevent overlapping checkpoint attempts don't
  persist across separate transactions the way they do for ordinary
  (non-transactional) writes. This weakens throttling precision under
  heavy transactional contention — it does not cause data loss or a
  broken write; concurrent checkpoint attempts still race safely
  through S3's own conditional-write CAS.
- **`registerS3Config()`'s registry is a one-way latch with no
  per-instance scoping.** In a process running multiple `SqliteS3Client`
  instances with genuinely different S3 configs, the first instance to
  populate the registry "wins" as the fallback for any other instance's
  constructor-less transaction clones. Not exercised by Ghost's actual
  deployment shape (one database per process), but a real sharp edge if
  that ever changes.
- **Retry budgets are fixed, not configurable per call site.** Both the
  commit-conflict retry loop and the transaction-reconciliation retry
  loop cap at 10 attempts with full-jitter backoff — matches the
  original Python reference this design ports from, but isn't tunable
  without editing the source.
