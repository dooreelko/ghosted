# sqlite-s3 Connection Contention Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the prod sign-in freeze (moth s0f42) by making `sqlite-s3` release its writer connection before the S3 upload completes, giving reads their own pool, and failing fast instead of hanging 30s.

**Architecture:** Three independent changes to `phase2/packages/sqlite-s3/src/knex-client.js` and `restore.js`: (B) split the commit-capture step (local, fast) from the S3-ship step (network, slow) so the pooled connection is released after capture, not after ship; (A) add a second, read-only connection pool routed via Knex's `Client.runner(builder)` override, keyed on `builder._method`; (C) lower the pool's `acquireTimeoutMillis` and add a small bounded retry inside `SqliteS3Client`. A is built on top of an atomic (rename-based) `restoreLocalDb` so a reader never observes a mid-rewrite file.

**Tech Stack:** Node.js (ESM), `better-sqlite3`, `knex@3.1.0`, `node:test` for unit tests, `@cucumber/cucumber` for e2e against a real S3 bucket.

**Spec:** `docs/superpowers/specs/2026-09-16-sqlite-s3-connection-contention-design.md`

## Global Constraints

- Package: `phase2/packages/sqlite-s3` — ESM (`"type": "module"` in its `package.json`), Node >=20.
- Unit tests: `node --test` (run via `npm test` in the package dir). Follow existing style in `test/knex-client.test.js` / `test/restore.test.js` (in-memory object store, `tmpdir()`-based db paths, real `better-sqlite3` where a real file is needed).
- E2E tests: `npm run test:e2e` (cucumber), against a **real** S3 bucket — needs real AWS credentials in the environment (see `e2e/support/hooks.js`'s `BeforeAll`, which fails loudly rather than skipping if credentials are missing). Do not mock S3 in the e2e suite.
- No DB schema change. No change to the wire format of manifests/segments — only connection-handling behavior.
- Never weaken the existing optimistic-concurrency/conflict-safety guarantees proven by `test/knex-client.test.js`'s existing tests (C1, C2, I1-I4, Important #1/#2) — every task that touches `knex-client.js` must re-run the full existing suite, not just its own new tests.
- Deploy path (post-merge, not part of this plan's tasks): `scripts/ssm-deploy-ghost-update.sh`, per `.local-secrets.md` "Ghost Custom Build Deploy Pipeline".

---

## Task 1: E2E reproduction (red) — prove the freeze against a real bucket, no Ghost

**Files:**
- Create: `phase2/packages/sqlite-s3/e2e/features/connection-contention.feature`
- Create: `phase2/packages/sqlite-s3/e2e/step_definitions/connection-contention.steps.js`
- Modify: none (reuses `e2e/support/hooks.js` and `e2e/support/world.js` as-is — same `BeforeAll`/`After`/`AfterAll` bucket lifecycle and `SqliteS3World.trackKnex` used by `multi-writer-reconciliation.feature`)

**Interfaces:**
- Consumes: `SqliteS3Client`, `registerS3Config` (or the `connection: {s3}` config form) from `src/knex-client.js`; `createS3ObjectStore` from `src/object-store.js`; `createManifestStore`/`createSegmentStore`/`createLeaseStore`/`createCheckpointPolicy` from `src/manifest.js`/`segments.js`/`leases.js`/`checkpoint.js` — same imports `multi-writer-reconciliation.steps.js` already uses.
- Produces: nothing consumed by later tasks — this is the reproduction harness that Task 3 makes pass.

This reproduces the incident shape directly: one writer doing several sequential inserts (standing in for a signup's automation-poll cascade, each paying a real S3 round-trip), concurrently with a second writer doing one insert (standing in for a sign-in write). Before the fix, the second writer's single insert queues behind all of the first writer's inserts' S3 round-trips; after the fix (Task 3), it only waits for the first writer's *local* commits, which are fast.

- [ ] **Step 1: Write the feature file**

```gherkin
Feature: A concurrent writer's own S3 round-trip does not block other writers

  Reproduces moth s0f42: before the connection-hold-time fix, one writer
  doing several sequential inserts (each paying a real S3 upload) holds the
  single pooled connection for the full duration of every upload, so an
  unrelated concurrent writer's single insert queues behind all of them.
  After the fix, the concurrent writer only waits for local commits, not
  S3 round-trips.

  Background:
    Given a throwaway S3 bucket for this test run

  Scenario: A concurrent single-insert writer is not blocked by another writer's multi-insert burst
    Given a shared "events" table created by a bootstrap writer
    When a burst writer starts inserting 6 rows into "events" one at a time, each via its own top-level statement
    And, once the burst writer's first insert has committed locally, a concurrent writer inserts 1 row into "events"
    Then the concurrent writer's insert completes in under 3 seconds
    And all 7 rows eventually appear in "events" once the burst writer finishes
```

- [ ] **Step 2: Write the step definitions**

```javascript
import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knexFactory from 'knex';
import { S3Client } from '@aws-sdk/client-s3';
import { createS3ObjectStore } from '../../src/object-store.js';
import { createManifestStore } from '../../src/manifest.js';
import { createSegmentStore } from '../../src/segments.js';
import { createLeaseStore } from '../../src/leases.js';
import { createCheckpointPolicy } from '../../src/checkpoint.js';
import { SqliteS3Client } from '../../src/knex-client.js';

async function tmpDbPath() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sqlite-s3-e2e-contention-'));
  return path.join(dir, 'app.db');
}

function makeS3Config(world) {
  const objectStore = createS3ObjectStore({ bucket: world.bucketName, client: world.s3Client });
  return {
    manifestStore: createManifestStore(objectStore),
    segmentStore: createSegmentStore(objectStore),
    leaseStore: createLeaseStore(objectStore),
    checkpointPolicy: createCheckpointPolicy({ maxWalBytes: 10_000_000, maxIntervalMs: 3_600_000 }),
  };
}

async function makeWriter(world) {
  const dbPath = await tmpDbPath();
  const knex = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: makeS3Config(world) },
    useNullAsDefault: true,
  });
  return world.trackKnex(knex);
}

Given('a shared {string} table created by a bootstrap writer', async function (tableName) {
  const bootstrap = await makeWriter(this);
  await bootstrap.schema.createTable(tableName, (t) => {
    t.increments('id');
    t.string('label');
  });
  this.tableName = tableName;
});

When(
  'a burst writer starts inserting {int} rows into {string} one at a time, each via its own top-level statement',
  async function (count, tableName) {
    const burstWriter = await makeWriter(this);
    this.firstBurstInsertDone = new Promise((resolve) => {
      this.resolveFirstBurstInsert = resolve;
    });
    this.burstDone = (async () => {
      for (let i = 0; i < count; i += 1) {
        await burstWriter(tableName).insert({ label: `burst-${i}` });
        if (i === 0) this.resolveFirstBurstInsert();
      }
    })();
  }
);

When(
  'once the burst writer\'s first insert has committed locally, a concurrent writer inserts {int} row into {string}',
  async function (count, tableName) {
    await this.firstBurstInsertDone;
    const concurrentWriter = await makeWriter(this);
    const startedAt = Date.now();
    for (let i = 0; i < count; i += 1) {
      await concurrentWriter(tableName).insert({ label: 'concurrent' });
    }
    this.concurrentWriteDurationMs = Date.now() - startedAt;
  }
);

Then('the concurrent writer\'s insert completes in under {int} seconds', function (seconds) {
  assert.ok(
    this.concurrentWriteDurationMs < seconds * 1000,
    `concurrent writer's insert took ${this.concurrentWriteDurationMs}ms, expected under ${seconds * 1000}ms — it queued behind the burst writer's S3 uploads`
  );
});

Then('all {int} rows eventually appear in {string} once the burst writer finishes', async function (expectedCount, tableName) {
  await this.burstDone;
  const reader = await makeWriter(this);
  const rows = await reader(tableName).select('*');
  assert.equal(rows.length, expectedCount);
});
```

- [ ] **Step 3: Run it and confirm it fails against `main` (pre-fix)**

Run: `cd phase2/packages/sqlite-s3 && npm run test:e2e -- --name "A concurrent single-insert writer is not blocked"`
Expected: FAIL on the "completes in under 3 seconds" step — the concurrent writer's insert queues behind the burst writer's remaining S3 uploads, taking several seconds (proportional to `(count - 1) * one S3 round-trip`).

- [ ] **Step 4: Commit**

```bash
git add phase2/packages/sqlite-s3/e2e/features/connection-contention.feature phase2/packages/sqlite-s3/e2e/step_definitions/connection-contention.steps.js
git commit -m "test: reproduce sqlite-s3 connection-hold contention against real S3 (moth s0f42, red)"
```

---

## Task 2: Split commit-capture from S3-ship, release connection before ship completes (B)

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/knex-client.js:98-272` (`_query`, `_maybeCaptureCommit`)
- Test: `phase2/packages/sqlite-s3/test/knex-client.test.js`

**Interfaces:**
- Consumes: `createCommitter({manifestStore, segmentStore}).commitWalDelta(payload, frames, pageSize, baseline)` from `src/commit.js` (unchanged signature) — returns `{segmentId, etag, manifest}` on success or `{retryTransaction: true}` on conflict.
- Produces: `SqliteS3Client._query(connection, obj)` — same signature and return value as before (callers/tests unaffected); a new process-level `pendingShip` promise tracked internally, awaited by `acquireRawConnection()` before restoring.

This is the core fix: today `_query()` awaits the entire S3 upload (`_maybeCaptureCommit`) before returning, and Knex only releases a connection back to the pool once `_query()` resolves — so the pool stays blocked for the full network round-trip. Split into a synchronous **capture** phase (parse the WAL delta off disk — fast, local-only, needed before the connection can safely be reused) and an async **ship** phase (the actual `commitWalDelta` S3 call), and only await capture inline.

- [ ] **Step 1: Write the failing tests**

Add to `test/knex-client.test.js`:

```javascript
test('the connection is released back to the pool before the S3 upload for that write completes', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();

  // A segmentStore whose putSegment() we can stall, so we can observe pool
  // state WHILE a ship is still in flight.
  const realSegmentStore = createSegmentStore(store);
  let releasePut;
  const stallOnce = new Promise((resolve) => { releasePut = resolve; });
  let putCalls = 0;
  const segmentStore = {
    ...realSegmentStore,
    putSegment: async (...args) => {
      putCalls += 1;
      if (putCalls === 1) await stallOnce;
      return realSegmentStore.putSegment(...args);
    },
  };
  const s3Config = {
    manifestStore: createManifestStore(store),
    segmentStore,
    leaseStore: createLeaseStore(store),
    checkpointPolicy: createCheckpointPolicy({ maxWalBytes: 10_000_000, maxIntervalMs: 3_600_000 }),
  };
  const knex = makeKnex(dbPath, s3Config);
  try {
    await knex.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });

    // This insert's ship (putSegment) is now stalled mid-flight. If the
    // connection were still held for the ship's duration, a second query
    // issued right now would hang until stallOnce resolves. Assert it
    // does NOT hang.
    const insertDone = knex('widgets').insert({ name: 'gizmo' });
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the insert's capture phase run

    const secondQueryStarted = Date.now();
    const rows = await knex('widgets').select('*'); // must not queue behind the stalled ship
    assert.ok(Date.now() - secondQueryStarted < 500, 'second query queued behind the in-flight S3 upload');
    assert.deepEqual(rows, []); // the stalled insert hasn't shipped/wouldn't even need to have landed to prove non-blocking

    releasePut();
    await insertDone;
  } finally {
    await knex.destroy();
  }
});

test('acquireRawConnection waits for the previous connection\'s pending ship before restoring (ordering constraint)', async () => {
  const store = createInMemoryObjectStore();
  const dbPathA = await tmpDbPath();

  const realManifestStore = createManifestStore(store);
  let releaseWrite;
  const stallOnce = new Promise((resolve) => { releaseWrite = resolve; });
  let writeCalls = 0;
  const manifestStore = {
    ...realManifestStore,
    write: async (...args) => {
      writeCalls += 1;
      if (writeCalls === 1) await stallOnce;
      return realManifestStore.write(...args);
    },
  };
  const s3Config = {
    manifestStore,
    segmentStore: createSegmentStore(store),
    leaseStore: createLeaseStore(store),
    checkpointPolicy: createCheckpointPolicy({ maxWalBytes: 10_000_000, maxIntervalMs: 3_600_000 }),
  };
  const knexA = makeKnex(dbPathA, s3Config);
  await knexA.schema.createTable('widgets', (t) => {
    t.increments('id');
    t.string('name');
  });
  const insertDone = knexA('widgets').insert({ name: 'gizmo' }); // ship stalls on manifestStore.write
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseWrite();
  await insertDone;
  await knexA.destroy(); // must wait for the pending ship internally, not leave it dangling

  // A fresh instance restoring from the same S3 state must see the shipped row —
  // proving destroy()/the next acquire didn't restore before the ship landed.
  const dbPathB = await tmpDbPath();
  const knexB = makeKnex(dbPathB, { ...s3Config, manifestStore: realManifestStore });
  const rows = await knexB('widgets').select('*');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'gizmo');
  await knexB.destroy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js`
Expected: FAIL — both new tests time out or the first one's "must not hang" assertion fails, since `_query` currently awaits the ship before returning.

- [ ] **Step 3: Implement the split**

Replace `_query`/`_maybeCaptureCommit` (`knex-client.js:98-272`) with a capture/ship split. Add a module-level (per-process, since the pool is `max:1` so there's only ever one physical connection) pending-ship tracker:

```javascript
// Module-level: at most one physical connection exists at a time (pool is
// pinned to max:1), so tracking one in-flight ship per process is
// equivalent to tracking one per connection, and survives the connection
// object itself being discarded/disposed before its ship resolves.
let pendingShip = Promise.resolve();

export class SqliteS3Client extends BetterSQLite3Client {
  // ...constructor, acquireRawConnection unchanged except as noted in Task 3...

  async acquireRawConnection() {
    // Never restore while a previous connection's ship is still deciding
    // whether this write's bytes are durable (and whether it was a
    // conflict) -- restoring now could read stale S3 state and silently
    // lose the pending write, or race the disposal flag the ship sets.
    await pendingShip.catch(() => {}); // errors are already logged where the ship runs; don't let them fail an unrelated new connection's acquire
    return super.acquireRawConnection();
  }

  async _query(connection, obj) {
    const result = await super._query(connection, obj);
    if (connection.inTransaction === false) {
      this._captureAndScheduleShip(connection);
    }
    return result;
  }

  _captureAndScheduleShip(connection) {
    const s3 = this._s3 ?? registry.s3;
    const captured = this._captureWalDelta(connection, s3);
    if (!captured) return; // nothing new to ship (see _captureWalDelta's early returns)

    const ship = this._shipCapturedDelta(connection, s3, captured).catch((err) => {
      // The caller that made this write has already gotten its response by
      // now -- there is no request left to reject. Log and mark the
      // connection disposed (same recovery path _maybeCaptureCommit used
      // to trigger synchronously) so the next acquire restores fresh.
      console.error('sqlite-s3: async commit ship failed:', err.message);
      if (connection) connection.__knex__disposed = err;
    });
    pendingShip = ship;
  }

  // Local-only: read the WAL delta off disk, identify the last committed
  // boundary, extract page images. Returns null if there's nothing new to
  // ship (no WAL growth, or no committed boundary in the delta yet).
  _captureWalDelta(connection, s3) {
    const walPath = `${this.connectionSettings.filename}-wal`;
    let size;
    try {
      size = statSync(walPath).size;
    } catch {
      return null; // no WAL file yet
    }
    const state = connection.__sqliteS3State ?? { lastWalOffset: 0, pageSize: null, baseline: { manifest: null, etag: null } };
    const lastWalOffset = state.lastWalOffset ?? 0;
    if (size <= lastWalOffset) return null;

    const delta = Buffer.alloc(size - lastWalOffset);
    const fd = openSync(walPath, 'r');
    readSync(fd, delta, 0, delta.length, lastWalOffset);
    closeSync(fd);

    const isFirstCapture = lastWalOffset === 0;
    const pageSize = isFirstCapture ? parseWalHeader(delta).pageSize : state.pageSize;
    const allFrames = parseFrames(delta, pageSize, isFirstCapture ? 32 : 0);

    let lastCommitFrameIndex = -1;
    for (let i = allFrames.length - 1; i >= 0; i -= 1) {
      if (allFrames[i].dbSizeAfterCommit !== 0) {
        lastCommitFrameIndex = i;
        break;
      }
    }
    if (lastCommitFrameIndex === -1) return null; // no committed boundary yet

    const lastCommitFrame = allFrames[lastCommitFrameIndex];
    const trimEnd = lastCommitFrame.offset + lastCommitFrame.length;
    const frames = allFrames.slice(0, lastCommitFrameIndex + 1);
    const pages = extractPageImages(delta, frames, pageSize);
    const payload = encodePageImages(pages);

    return { state, lastWalOffset, trimEnd, pageSize, frames, payload };
  }

  // Network: ship the captured delta to S3. Runs AFTER the connection has
  // already been released back to the pool by the caller of _query -- must
  // not touch `connection` for anything other than bookkeeping fields that
  // don't require exclusive access (state/checkpoint-in-flight flags),
  // since another query may already be running on it by the time this
  // resolves.
  async _shipCapturedDelta(connection, s3, captured) {
    const { state, lastWalOffset, trimEnd, pageSize, frames, payload } = captured;
    const committer = createCommitter({ manifestStore: s3.manifestStore, segmentStore: s3.segmentStore });
    const outcome = await committer.commitWalDelta(payload, frames, pageSize, state.baseline);

    if (outcome.retryTransaction) {
      const err = new Error(
        "sqlite-s3: local write committed but lost an optimistic-concurrency race shipping to S3 — this writer's local state has diverged from the shared history"
      );
      err.sqliteS3Conflict = true;
      if (connection) connection.__knex__disposed = err;
      throw err;
    }

    state.pageSize = pageSize;
    state.lastWalOffset = lastWalOffset + trimEnd;
    state.baseline = { manifest: outcome.manifest, etag: outcome.etag };
    connection.__sqliteS3State = state;
    s3.checkpointPolicy.recordSegment(payload.length);

    this._maybeKickOffCheckpoint(s3);
  }

  // Unchanged logic from the old inline checkpoint kick-off at the end of
  // _maybeCaptureCommit, just extracted so _shipCapturedDelta stays
  // readable. Still fire-and-forget, still cooldown-guarded.
  _maybeKickOffCheckpoint(s3) {
    try {
      if (
        s3.checkpointPolicy.shouldCheckpoint() &&
        !this._checkpointInFlight &&
        Date.now() >= (this._nextCheckpointAttemptAt ?? 0)
      ) {
        this._checkpointInFlight = true;
        const CHECKPOINT_COOLDOWN_MS = 30_000;
        performCheckpoint({ manifestStore: s3.manifestStore, segmentStore: s3.segmentStore, leaseStore: s3.leaseStore })
          .then((result) => {
            if (result.checkpointed) s3.checkpointPolicy.recordCheckpoint();
          })
          .catch((err) => {
            console.error('sqlite-s3: checkpoint attempt failed (non-fatal):', err);
          })
          .finally(() => {
            this._checkpointInFlight = false;
            this._nextCheckpointAttemptAt = Date.now() + CHECKPOINT_COOLDOWN_MS;
          });
      }
    } catch (err) {
      console.error('sqlite-s3: checkpoint attempt failed (non-fatal):', err);
    }
  }
}
```

Also update `destroy()`-adjacent behavior: Knex's `knex.destroy()` calls `client.destroy()`, which is not overridden today. Add one so tests (and prod shutdown) don't tear down while a ship is still in flight:

```javascript
async destroy() {
  await pendingShip.catch(() => {});
  return super.destroy();
}
```

**Note on `transaction()`'s reconciliation path (`knex-client.js:274-320`):** it already runs `_maybeCaptureCommit` only via the same `_query` hook (the COMMIT statement inside a transaction goes through `_query` too, `connection.inTransaction === false` right after COMMIT), so it picks up the new capture/ship split automatically — no changes needed there.

- [ ] **Step 4: Run the new tests and the full existing suite**

Run: `cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js`
Expected: PASS — both new tests, and every pre-existing test in the file (C1, C2, I1-I4, Important #1/#2, checkpoint tests) still pass unmodified.

- [ ] **Step 5: Run the Task 1 e2e reproduction**

Run: `cd phase2/packages/sqlite-s3 && npm run test:e2e -- --name "A concurrent single-insert writer is not blocked"`
Expected: PASS — the concurrent writer's insert now only waits for the burst writer's local commit, not its S3 upload.

- [ ] **Step 6: Commit**

```bash
git add phase2/packages/sqlite-s3/src/knex-client.js phase2/packages/sqlite-s3/test/knex-client.test.js
git commit -m "fix: release sqlite-s3 connection before S3 upload completes (moth s0f42)"
```

---

## Task 3: Atomic restore (rename swap)

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/restore.js:15-17,38`
- Test: `phase2/packages/sqlite-s3/test/restore.test.js`

**Interfaces:**
- Consumes: `node:fs/promises` (`rm`, `writeFile`, `rename`).
- Produces: `restoreLocalDb({...})` — same signature and return shape (`{attempts, durationMs}`) as before; only the on-disk write sequence changes. Task 4's reader pool depends on this being safe to open concurrently with a restore in progress.

- [ ] **Step 1: Write the failing test**

Add to `test/restore.test.js`:

```javascript
test('restoreLocalDb never leaves dbPath missing or truncated to a reader racing the restore (atomic swap)', async () => {
  const objectStore = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);
  const manifestStore = createManifestStore(objectStore);
  const pageSize = 16;
  const payload = Buffer.alloc(pageSize * 4, 0xab); // large-ish so the write isn't a single syscall
  const baseSegmentId = await segmentStore.putSegment(payload);
  const manifest = { baseSegmentId, walSegmentIds: [], pageSize };

  const dbPath = await tmpPath('atomic-swap.db');
  // Seed an existing file first, matching a real restore-of-an-existing-connection.
  await require('node:fs/promises').writeFile(dbPath, Buffer.alloc(pageSize, 0x00));

  let sawMissingOrShortRead = false;
  let keepPolling = true;
  const poller = (async () => {
    while (keepPolling) {
      try {
        const bytes = await readFile(dbPath);
        if (bytes.length !== pageSize && bytes.length !== payload.length) {
          sawMissingOrShortRead = true;
        }
      } catch (err) {
        if (err.code === 'ENOENT') sawMissingOrShortRead = true;
        else throw err;
      }
    }
  })();

  await restoreLocalDb({ manifest, manifestStore, segmentStore, leaseStore, dbPath });
  keepPolling = false;
  await poller;

  assert.equal(sawMissingOrShortRead, false, 'a concurrent reader must only ever see the old complete file or the new complete file, never missing/partial');
  const finalBytes = await readFile(dbPath);
  assert.deepEqual(finalBytes, payload);
});
```

(Add `import { readFile, writeFile } from 'node:fs/promises';` alongside the file's existing imports rather than the inline `require` above — written inline here only to show what's needed; use the top-of-file import in the actual edit.)

- [ ] **Step 2: Run it to verify it fails (or is flaky-failing)**

Run: `cd phase2/packages/sqlite-s3 && node --test test/restore.test.js`
Expected: intermittent FAIL on `sawMissingOrShortRead` — `rm` then `writeFile` has a real window where the file is absent or partially written.

- [ ] **Step 3: Implement the atomic swap**

In `restoreLocalDb` (`restore.js`), change:

```javascript
await rm(dbPath, { force: true });
await rm(`${dbPath}-wal`, { force: true });
await rm(`${dbPath}-shm`, { force: true });
```

to defer the `dbPath` removal (keep the `-wal`/`-shm` removal as-is — nothing reads those directly mid-restore):

```javascript
await rm(`${dbPath}-wal`, { force: true });
await rm(`${dbPath}-shm`, { force: true });
```

and change the write at the end of the function:

```javascript
await writeFile(dbPath, fileBytes);
```

to write-to-temp-then-rename:

```javascript
const tmpPath = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
await writeFile(tmpPath, fileBytes);
await rename(tmpPath, dbPath); // atomic on the same filesystem — readers see the old or new file, never a torn one
```

(Add `rename` to the `node:fs/promises` import at the top of the file; the "truly nothing to restore" early-return path, `restore.js:21-23`, is unaffected since it never touches `dbPath` at all.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd phase2/packages/sqlite-s3 && node --test test/restore.test.js`
Expected: PASS, including the new atomic-swap test and every pre-existing test in the file (lease acquisition/release, retry-on-reclaim, C2 multi-writer composition, etc).

- [ ] **Step 5: Commit**

```bash
git add phase2/packages/sqlite-s3/src/restore.js phase2/packages/sqlite-s3/test/restore.test.js
git commit -m "fix: make restoreLocalDb's file rewrite atomic via rename (prereq for reader pool)"
```

---

## Task 4: Separate read-only connection pool (A)

**Files:**
- Create: `phase2/packages/sqlite-s3/src/reader-client.js`
- Modify: `phase2/packages/sqlite-s3/src/knex-client.js` (constructor, add `runner()` override)
- Modify: `phase2/packages/sqlite-s3/src/index.js` (export `ReaderClient`)
- Test: `phase2/packages/sqlite-s3/test/reader-client.test.js` (new), additions to `test/knex-client.test.js`

**Interfaces:**
- Consumes: `BetterSQLite3Client` (from `knex/lib/dialects/better-sqlite3/index.js`, same import `knex-client.js:2` already uses).
- Produces: `ReaderClient` class (exported from `src/index.js`); `SqliteS3Client` constructor accepts `config.connection.readerPoolSize` (default `4`) and constructs an internal `ReaderClient` pointed at the same `filename`; `SqliteS3Client.prototype.runner(builder)` — overrides `Client.prototype.runner`.

`ReaderClient` opens the same on-disk file the writer maintains, read-only, with a real multi-connection pool. It never restores from S3 (the writer already keeps the local file current — and Task 3 made that rewrite atomic, so opening it concurrently is safe) and never runs commit-capture (nothing to capture — read-only).

- [ ] **Step 1: Write the failing tests for `ReaderClient`**

Create `test/reader-client.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knexFactory from 'knex';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { createManifestStore } from '../src/manifest.js';
import { createCheckpointPolicy } from '../src/checkpoint.js';
import { createLeaseStore } from '../src/leases.js';
import { SqliteS3Client } from '../src/knex-client.js';
import { ReaderClient } from '../src/reader-client.js';

async function tmpDbPath() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sqlite-s3-reader-test-'));
  return path.join(dir, 'app.db');
}

test('ReaderClient sees data the writer already committed to the same file', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const s3Config = {
    manifestStore: createManifestStore(store),
    segmentStore: createSegmentStore(store),
    leaseStore: createLeaseStore(store),
    checkpointPolicy: createCheckpointPolicy({ maxWalBytes: 10_000_000, maxIntervalMs: 3_600_000 }),
  };
  const writer = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: s3Config },
    useNullAsDefault: true,
  });
  try {
    await writer.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });
    await writer('widgets').insert({ name: 'gizmo' });

    const reader = knexFactory({
      client: ReaderClient,
      connection: { filename: dbPath },
      pool: { min: 1, max: 3 },
      useNullAsDefault: true,
    });
    try {
      const rows = await reader('widgets').select('*');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'gizmo');
    } finally {
      await reader.destroy();
    }
  } finally {
    await writer.destroy();
  }
});

test('ReaderClient rejects writes (query_only)', async () => {
  const dbPath = await tmpDbPath();
  const store = createInMemoryObjectStore();
  const writer = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: { manifestStore: createManifestStore(store), segmentStore: createSegmentStore(store), leaseStore: createLeaseStore(store), checkpointPolicy: createCheckpointPolicy({ maxWalBytes: 10_000_000, maxIntervalMs: 3_600_000 }) } },
    useNullAsDefault: true,
  });
  try {
    await writer.schema.createTable('widgets', (t) => t.increments('id'));
    const reader = knexFactory({ client: ReaderClient, connection: { filename: dbPath }, useNullAsDefault: true });
    try {
      await assert.rejects(() => reader('widgets').insert({}));
    } finally {
      await reader.destroy();
    }
  } finally {
    await writer.destroy();
  }
});

test('ReaderClient pool honors the configured max concurrent connections', async () => {
  const dbPath = await tmpDbPath();
  const reader = knexFactory({
    client: ReaderClient,
    connection: { filename: dbPath },
    pool: { min: 1, max: 3 },
    useNullAsDefault: true,
  });
  try {
    assert.equal(reader.client.pool.max, 3);
  } finally {
    await reader.destroy();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd phase2/packages/sqlite-s3 && node --test test/reader-client.test.js`
Expected: FAIL with `Cannot find module '../src/reader-client.js'`.

- [ ] **Step 3: Implement `ReaderClient`**

Create `src/reader-client.js`:

```javascript
import BetterSQLite3Client from 'knex/lib/dialects/better-sqlite3/index.js';

// A plain, read-only view onto the SAME on-disk file SqliteS3Client's
// writer maintains. Never restores from S3 (the writer already keeps the
// file current, and restoreLocalDb's rewrite is atomic via rename — see
// restore.js — so opening the file here concurrently with a writer-side
// restore is safe: this always sees either the old complete file or the
// new complete file). Never participates in commit-capture — read-only
// connections produce no WAL growth of their own to ship.
export class ReaderClient extends BetterSQLite3Client {
  constructor(config) {
    // Pool size is caller-controlled (unlike the writer, which MUST stay
    // pinned to one connection) -- SQLite's WAL mode natively supports many
    // concurrent readers alongside the one writer.
    super(config);
  }

  async acquireRawConnection() {
    const connection = await super.acquireRawConnection();
    connection.pragma('query_only = ON');
    return connection;
  }
}
```

- [ ] **Step 4: Run `ReaderClient` tests to verify they pass**

Run: `cd phase2/packages/sqlite-s3 && node --test test/reader-client.test.js`
Expected: PASS.

- [ ] **Step 5: Export `ReaderClient`**

Add to `src/index.js`:

```javascript
export { ReaderClient } from './reader-client.js';
```

- [ ] **Step 6: Write the failing routing test in `knex-client.test.js`**

```javascript
test('SqliteS3Client routes read-only queries to the reader pool, everything else to the writer pool', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const s3Config = { ...makeS3Config(store), readerPoolSize: 2 };
  const knex = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: s3Config },
    useNullAsDefault: true,
  });
  try {
    await knex.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });
    await knex('widgets').insert({ name: 'gizmo' });

    // A read must not queue behind a held writer-pool connection: acquire
    // the writer connection directly and hold it open, then verify a
    // concurrent SELECT still completes promptly via the reader pool.
    const writerClient = knex.client;
    const heldConnection = await writerClient.acquireConnection();
    try {
      const startedAt = Date.now();
      const rows = await knex('widgets').select('*');
      assert.ok(Date.now() - startedAt < 500, 'read queued behind the held writer connection instead of using the reader pool');
      assert.equal(rows.length, 1);
    } finally {
      await writerClient.releaseConnection(heldConnection);
    }
  } finally {
    await knex.destroy();
  }
});

test('a write is never routed to the reader pool even while it is idle', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const knex = makeKnex(dbPath, { ...makeS3Config(store), readerPoolSize: 2 });
  try {
    await knex.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });
    await knex('widgets').insert({ name: 'gizmo' });
    const rows = await knex('widgets').select('*');
    assert.equal(rows.length, 1, 'the insert must be visible to a same-process read — proving it landed on the writer, not a stale reader-pool connection opened before the insert');
  } finally {
    await knex.destroy();
  }
});
```

- [ ] **Step 7: Run to verify failure**

Run: `cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js`
Expected: FAIL on the first new test (reads currently share the writer pool — no reader pool exists yet).

- [ ] **Step 8: Implement routing in `SqliteS3Client`**

In `knex-client.js`, add to the constructor (after the existing `super(...)` call, `knex-client.js:39`) and add the `runner()` override:

```javascript
import { ReaderClient } from './reader-client.js';

// ...inside the constructor, after `this._s3 = ...`:
    const readerPoolSize = config.connection?.s3?.readerPoolSize ?? config.readerPoolSize ?? 4;
    this._readerClient = new ReaderClient({
      ...config,
      pool: { min: 1, max: readerPoolSize },
      connection: { filename: config.connection.filename },
    });

// ...new methods on the class:
  runner(builder) {
    const runner = super.runner(builder);
    if (SqliteS3Client._isReadOnlyBuilder(builder)) {
      runner.client = this._readerClient;
    }
    return runner;
  }

  // Conservative by construction: anything that isn't recognizably a plain
  // read (missing `_method`, e.g. a SchemaBuilder or Raw query, or a
  // `_method` outside the known read-only set) stays on the writer pool.
  // Misrouting a write to the reader pool would be a correctness bug;
  // misrouting a read to the writer pool only costs a little contention.
  static _isReadOnlyBuilder(builder) {
    const READ_ONLY_METHODS = new Set(['select', 'first', 'pluck', 'columnInfo']);
    return typeof builder?._method === 'string' && READ_ONLY_METHODS.has(builder._method);
  }

  async destroy() {
    await pendingShip.catch(() => {});
    await this._readerClient.destroy();
    return super.destroy();
  }
```

(This replaces the plain `destroy()` override added in Task 2 — fold the two into one method as shown here.)

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js test/reader-client.test.js`
Expected: PASS — including every pre-existing test (routing must not affect schema-builder DDL, transactions, or raw SQL, all of which lack a recognizable read-only `_method` and stay on the writer).

- [ ] **Step 10: Commit**

```bash
git add phase2/packages/sqlite-s3/src/reader-client.js phase2/packages/sqlite-s3/src/knex-client.js phase2/packages/sqlite-s3/src/index.js phase2/packages/sqlite-s3/test/reader-client.test.js phase2/packages/sqlite-s3/test/knex-client.test.js
git commit -m "feat: route read-only queries to a separate reader connection pool (moth s0f42)"
```

---

## Task 5: Fail-fast acquire timeout + bounded retry (C)

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/knex-client.js` (constructor's `pool` config, new `acquireConnection()` override)
- Test: `phase2/packages/sqlite-s3/test/knex-client.test.js`

**Interfaces:**
- Consumes: none new.
- Produces: `SqliteS3Client` constructor accepts `config.connection.s3.acquireTimeoutMillis` (default `5000`) and `config.connection.s3.acquireRetries` (default `1`, i.e. one retry after the first timeout).

- [ ] **Step 1: Write the failing test**

```javascript
test('acquireConnection retries once on a timeout before giving up, and fails fast rather than hanging 30s', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const s3Config = { ...makeS3Config(store), acquireTimeoutMillis: 200, acquireRetries: 1 };
  const knex = makeKnex(dbPath, s3Config);
  try {
    await knex.schema.createTable('widgets', (t) => t.increments('id'));

    // Hold the only writer connection open so every other acquire attempt
    // genuinely times out.
    const held = await knex.client.pool.acquire().promise;
    try {
      const startedAt = Date.now();
      await assert.rejects(() => knex('widgets').insert({}));
      const elapsed = Date.now() - startedAt;
      // Two attempts at ~200ms each, not the old ~30s default.
      assert.ok(elapsed < 2000, `expected fast failure well under 2s, took ${elapsed}ms`);
      assert.ok(elapsed >= 200, 'must have actually attempted at least once, not failed instantly');
    } finally {
      knex.client.pool.release(held);
    }
  } finally {
    await knex.destroy();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js`
Expected: FAIL (times out around the current ~30s default, or the `acquireTimeoutMillis`/`acquireRetries` config options are silently ignored).

- [ ] **Step 3: Implement**

In the constructor (`knex-client.js:39`), extend the pinned pool config to include the timeout:

```javascript
const acquireTimeoutMillis = config.connection?.s3?.acquireTimeoutMillis ?? 5000;
super({ ...config, pool: { min: 1, max: 1, acquireTimeoutMillis } });
this._acquireRetries = config.connection?.s3?.acquireRetries ?? 1;
```

Add an `acquireConnection()` override (bounded retry, same short timeout each attempt):

```javascript
async acquireConnection() {
  let lastErr;
  for (let attempt = 0; attempt <= this._acquireRetries; attempt += 1) {
    try {
      return await super.acquireConnection();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
```

`ReaderClient` gets the same treatment for consistency — in `reader-client.js`, accept `config.acquireTimeoutMillis` (default `5000`) and pass it through to `super(config)`'s `pool` (the reader pool's `max` stays caller-controlled from Task 4; only `acquireTimeoutMillis` is added here):

```javascript
constructor(config) {
  super({ ...config, pool: { ...config.pool, acquireTimeoutMillis: config.acquireTimeoutMillis ?? 5000 } });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js test/reader-client.test.js`
Expected: PASS, including all pre-existing tests (the default `acquireTimeoutMillis: 5000` is a behavior change from tarn's implicit ~30000 default — re-check no existing test relies on a query legitimately taking longer than 5s to acquire; none currently do based on the file's content).

- [ ] **Step 5: Commit**

```bash
git add phase2/packages/sqlite-s3/src/knex-client.js phase2/packages/sqlite-s3/src/reader-client.js phase2/packages/sqlite-s3/test/knex-client.test.js
git commit -m "fix: fail fast with bounded retry on connection acquire instead of hanging ~30s (moth s0f42)"
```

---

## Task 6: Full e2e reproduction passes; wire real config in the launcher

**Files:**
- Modify: `phase2/packages/ghost-sqlite-s3-launcher/src/preload.mjs` (the `config.set('database:connection', ...)` block)
- Test: `phase2/packages/ghost-sqlite-s3-launcher/test/*` (existing suite — no new file needed unless preload.mjs's own tests cover this block already; check first)

**Interfaces:**
- Consumes: `SqliteS3Client` from `@ghost-phase2/sqlite-s3` (already imported in `preload.mjs`).
- Produces: nothing consumed by later tasks — this is the final integration wiring.

- [ ] **Step 1: Check whether `preload.mjs`'s config-setting block is covered by an existing test**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && grep -rn "database:connection\|readerPoolSize" test/`
If a test already exercises this block, extend it with an assertion on the new field; otherwise this step's wiring is integration-only (the launcher package's existing tests target its individually-exported pure functions, not the top-level preload script's side effects — confirm this by reading `test/database-info-patch.test.mjs` briefly before deciding).

- [ ] **Step 2: Wire the new options**

In `preload.mjs`, extend the existing block (found via `grep -n "database:connection" src/preload.mjs`):

```javascript
config.set('database:connection', {
  filename: path.join(dataDir, 'ghost.db'),
  s3: {
    ...s3Config,
    readerPoolSize: Number(process.env.SQLITE_S3_READER_POOL_SIZE ?? 4),
    acquireTimeoutMillis: Number(process.env.SQLITE_S3_ACQUIRE_TIMEOUT_MS ?? 5000),
  },
});
```

- [ ] **Step 3: Run the full e2e suite (Task 1's reproduction plus the existing multi-writer suite) against a real bucket**

Run: `cd phase2/packages/sqlite-s3 && npm run test:e2e`
Expected: PASS — both `connection-contention.feature` (Task 1, now green) and the pre-existing `multi-writer-reconciliation.feature`.

- [ ] **Step 4: Run every unit suite in both packages**

Run: `cd phase2/packages/sqlite-s3 && npm test && cd ../ghost-sqlite-s3-launcher && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add phase2/packages/ghost-sqlite-s3-launcher/src/preload.mjs
git commit -m "feat: wire reader-pool size and acquire timeout into Ghost boot config (moth s0f42)"
```

---

## Manual verification (post-merge, not part of this plan's automated tasks)

Per the spec's Rollout section: deploy via `scripts/ssm-deploy-ghost-update.sh`, then replay the concurrent signup+signin pattern against staging and confirm no 30s hangs in Lightsail container logs (`aws lightsail get-container-log --service-name ghost-phase2 --container-name ghost`).
