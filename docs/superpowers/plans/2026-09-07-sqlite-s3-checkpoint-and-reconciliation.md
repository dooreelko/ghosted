# Checkpointing and Transaction Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up two previously-parked capabilities in `phase2/packages/sqlite-s3/`: (1) checkpointing — periodically merging the manifest's growing WAL-segment history into a new base segment, bounding restore time — and (2) conflict reconciliation for `knex.transaction()`-wrapped writes — safely retrying a whole transaction against fresh state when it loses an optimistic-concurrency race, instead of just surfacing an honest but unrecoverable error.

**Architecture:** Checkpointing reuses `restore.js`'s existing "merge every segment into one consistent file" logic (extracted into a shared `merge.js` module) to build a new base segment — safe because it reflects every writer's history, not just the checkpointing writer's own local state. Reconciliation uses Knex's own connection-disposal convention (`connection.__knex__disposed = err`, already used internally by Knex's own dialects) to force the pool to discard a diverged connection and re-acquire a fresh one (which re-restores from S3), combined with an override of `transaction()` that catches a tagged conflict error and re-invokes the caller's whole transaction callback against that fresh state.

**Tech Stack:** Same as the existing package — Node.js (ESM), `better-sqlite3`, `knex`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-07-sqlite-s3-design.md` (see "Checkpointing" → "Implementation" subsection, and "Conflict reconciliation")

## Global Constraints

- No new external dependencies.
- Checkpointing is best-effort: a CAS conflict during checkpoint attempt is abandoned silently (not retried within the same attempt), never breaks the caller's actual write, and is safe to skip — the trigger policy fires again later.
- Reconciliation is scoped to `knex.transaction(async trx => {...})`-wrapped writes only. Bare autocommit writes outside a transaction are NOT retried — this is a documented, accepted gap (see spec's "Known limitations"), not something this plan fixes.
- Nested transactions (savepoints, i.e. `outerTx` is set) are NOT retried — retrying would require discarding a connection a parent transaction still owns, breaking savepoint semantics. Only top-level transactions get reconciliation.
- Retry budget for transaction reconciliation: 10 attempts (matches the existing commit-retry budget elsewhere in this package — not a new number invented for this).
- All 47 existing tests must keep passing unmodified. `restore.test.js`'s existing assertions must produce byte-identical output after the `merge.js` extraction (this is a refactor, not a behavior change, for that file).

---

## File Structure

```
phase2/packages/sqlite-s3/
  src/
    merge.js            # NEW — buildMergedFileBytes({manifest, segmentStore}) -> Buffer, extracted from restore.js
    restore.js            # MODIFIED — thin wrapper: delete stale files, delegate merging to merge.js, write result
    checkpoint.js           # MODIFIED — adds performCheckpoint({manifestStore, segmentStore}), createCheckpointPolicy unchanged
    knex-client.js            # MODIFIED — wires performCheckpoint in after successful commits; adds transaction() override + connection-disposal on conflict
  test/
    merge.test.js       # NEW
    restore.test.js       # UNCHANGED (regression safety net for the extraction)
    checkpoint.test.js      # MODIFIED — adds tests for performCheckpoint
    knex-client.test.js       # MODIFIED — adds tests for checkpoint wiring and transaction reconciliation
```

`merge.js` sits below both `restore.js` and `checkpoint.js` — it owns exactly one responsibility (turn a manifest + segment store into the merged file bytes it describes), and neither of its two callers needs to know how the other uses it.

---

### Task 1: merge.js — extract shared merge logic from restore.js

**Files:**
- Create: `phase2/packages/sqlite-s3/src/merge.js`
- Modify: `phase2/packages/sqlite-s3/src/restore.js`
- Test: `phase2/packages/sqlite-s3/test/merge.test.js`

**Interfaces:**
- Consumes: `decodePageImages` from `./page-images.js` (already exists).
- Produces: `buildMergedFileBytes({ manifest, segmentStore }) -> Promise<Buffer>` — given a manifest and segment store, returns the fully-merged file bytes (base segment overlaid with every wal segment's page images, in manifest order, truncated to the maximum `dbSizeAfterCommit` seen). Returns `Buffer.alloc(0)` if there's truly nothing to merge (no manifest, or a manifest with neither a base nor any wal segments) — callers decide what that means for them (restore.js treats it as "leave no file"; checkpoint.js, in Task 2, treats a manifest with no wal segments as "nothing to checkpoint" before ever calling this function, so it won't hit that path in practice).

This is a pure refactor: the logic moves, but produces byte-identical output to what `restore.js` currently computes inline. `restore.test.js` is the regression test — it must keep passing completely unmodified.

- [ ] **Step 1: Write the failing test**

```js
// phase2/packages/sqlite-s3/test/merge.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { encodePageImages } from '../src/page-images.js';
import { buildMergedFileBytes } from '../src/merge.js';

test('buildMergedFileBytes returns an empty buffer for a null manifest', async () => {
  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const result = await buildMergedFileBytes({ manifest: null, segmentStore });
  assert.equal(result.length, 0);
});

test('buildMergedFileBytes overlays a wal segment onto the base at the correct offset', async () => {
  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const pageSize = 16;
  const baseBytes = Buffer.alloc(pageSize * 2, 0x00);
  const baseSegmentId = await segmentStore.putSegment(baseBytes);
  const walSegmentId = await segmentStore.putSegment(
    encodePageImages([{ pageNumber: 2, bytes: Buffer.alloc(pageSize, 0xaa) }]),
    { dbSizeAfterCommit: 2 }
  );
  const manifest = { baseSegmentId, walSegmentIds: [walSegmentId], pageSize };

  const result = await buildMergedFileBytes({ manifest, segmentStore });
  assert.equal(result.length, pageSize * 2);
  assert.ok(result.subarray(0, pageSize).every((b) => b === 0x00), 'page 1 untouched');
  assert.ok(result.subarray(pageSize, pageSize * 2).every((b) => b === 0xaa), 'page 2 overlaid');
});

test('buildMergedFileBytes truncates to the maximum dbSizeAfterCommit across all segments', async () => {
  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const pageSize = 16;
  const baseBytes = Buffer.alloc(pageSize, 0x00);
  const baseSegmentId = await segmentStore.putSegment(baseBytes);
  // First segment grows the db to 3 pages; second (landing later) only touches page 1
  // with a smaller dbSizeAfterCommit — must NOT truncate away the growth.
  const growSegId = await segmentStore.putSegment(
    encodePageImages([
      { pageNumber: 2, bytes: Buffer.alloc(pageSize, 0x02) },
      { pageNumber: 3, bytes: Buffer.alloc(pageSize, 0x03) },
    ]),
    { dbSizeAfterCommit: 3 }
  );
  const smallSegId = await segmentStore.putSegment(
    encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0x99) }]),
    { dbSizeAfterCommit: 1 }
  );
  const manifest = { baseSegmentId, walSegmentIds: [growSegId, smallSegId], pageSize };

  const result = await buildMergedFileBytes({ manifest, segmentStore });
  assert.equal(result.length, pageSize * 3, 'must not truncate away page 2/3 from the growing segment');
});

test('buildMergedFileBytes throws a clear error when pageSize is missing but wal segments exist', async () => {
  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const manifest = { baseSegmentId: null, walSegmentIds: ['some-id'], pageSize: undefined };
  await assert.rejects(() => buildMergedFileBytes({ manifest, segmentStore }), /pageSize is missing or invalid/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/merge.test.js
```

Expected: FAIL — `src/merge.js` does not exist.

- [ ] **Step 3: Write merge.js, extracting the logic currently inline in restore.js**

```js
// phase2/packages/sqlite-s3/src/merge.js
import { decodePageImages } from './page-images.js';

export async function buildMergedFileBytes({ manifest, segmentStore }) {
  const hasWalSegments = manifest && manifest.walSegmentIds && manifest.walSegmentIds.length > 0;
  if (!manifest || (!manifest.baseSegmentId && !hasWalSegments)) {
    return Buffer.alloc(0);
  }

  if (hasWalSegments && !(Number.isInteger(manifest.pageSize) && manifest.pageSize > 0)) {
    throw new Error(
      `buildMergedFileBytes: manifest.pageSize is missing or invalid (${manifest.pageSize}) but wal segments exist — cannot compute page offsets`
    );
  }

  let fileBytes = Buffer.alloc(0);
  if (manifest.baseSegmentId) {
    const base = await segmentStore.getSegment(manifest.baseSegmentId);
    fileBytes = Buffer.from(base.bytes);

    if (manifest.pageSize && fileBytes.length >= 18) {
      const rawPageSize = fileBytes.readUInt16BE(16);
      const basePageSize = rawPageSize === 1 ? 65536 : rawPageSize;
      if (basePageSize !== manifest.pageSize) {
        throw new Error(
          `buildMergedFileBytes: manifest.pageSize (${manifest.pageSize}) does not match the base segment's own page size (${basePageSize})`
        );
      }
    }
  }

  const pageSize = manifest.pageSize;
  let finalPageCount = pageSize > 0 ? Math.floor(fileBytes.length / pageSize) : 0;

  for (const walSegmentId of manifest.walSegmentIds ?? []) {
    const seg = await segmentStore.getSegment(walSegmentId);
    const pages = decodePageImages(seg.bytes);
    for (const { pageNumber, bytes } of pages) {
      const endOffset = pageNumber * pageSize;
      if (endOffset > fileBytes.length) {
        const grown = Buffer.alloc(endOffset);
        fileBytes.copy(grown);
        fileBytes = grown;
      }
      bytes.copy(fileBytes, (pageNumber - 1) * pageSize);
    }
    if (seg.meta?.dbSizeAfterCommit) {
      finalPageCount = Math.max(finalPageCount, seg.meta.dbSizeAfterCommit);
    }
  }

  if (finalPageCount > 0) {
    fileBytes = fileBytes.subarray(0, finalPageCount * pageSize);
  }

  return fileBytes;
}
```

- [ ] **Step 4: Update restore.js to delegate to merge.js**

Replace `phase2/packages/sqlite-s3/src/restore.js` entirely with:

```js
// phase2/packages/sqlite-s3/src/restore.js
import { rm, writeFile } from 'node:fs/promises';
import { buildMergedFileBytes } from './merge.js';

export async function restoreLocalDb({ manifest, segmentStore, dbPath }) {
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });

  const hasWalSegments = manifest && manifest.walSegmentIds && manifest.walSegmentIds.length > 0;
  if (!manifest || (!manifest.baseSegmentId && !hasWalSegments)) {
    return; // truly nothing to restore — a fresh database
  }

  const fileBytes = await buildMergedFileBytes({ manifest, segmentStore });
  await writeFile(dbPath, fileBytes);
}
```

- [ ] **Step 5: Run merge.test.js, then the full suite**

```bash
cd phase2/packages/sqlite-s3 && node --test test/merge.test.js
```

Expected: PASS, 4 tests.

```bash
cd phase2/packages/sqlite-s3 && npm test
```

Expected: PASS, all 47 pre-existing tests plus the 4 new ones — `restore.test.js`'s tests must pass completely unmodified, proving the extraction didn't change behavior.

- [ ] **Step 6: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/merge.js src/restore.js test/merge.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: extract shared merge logic into merge.js

buildMergedFileBytes() is the same base+overlay+max-truncate logic
restore.js already had, extracted so checkpointing (next task) can
reuse it instead of duplicating page-table-merge logic in a second
place. Pure refactor — restore.test.js passes unmodified, proving no
behavior change.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

### Task 2: checkpoint.js — performCheckpoint

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/checkpoint.js`
- Modify: `phase2/packages/sqlite-s3/test/checkpoint.test.js`

**Interfaces:**
- Consumes: `buildMergedFileBytes` from `./merge.js` (Task 1); `ManifestConflictError` semantics from `./manifest.js` (already exists — a manifest write rejects with `err.name === 'ManifestConflictError'` on a CAS conflict).
- Produces: `performCheckpoint({ manifestStore, segmentStore }) -> Promise<{ checkpointed: boolean }>`. `createCheckpointPolicy` (existing export) is unchanged.

This does NOT touch `createCheckpointPolicy` — that trigger-decision logic already exists and already works. This task only adds the function that actually *performs* a checkpoint when the policy says to.

- [ ] **Step 1: Write the failing test**

Append these tests to the existing `phase2/packages/sqlite-s3/test/checkpoint.test.js` (leave the existing `createCheckpointPolicy` tests untouched):

```js
// Append to phase2/packages/sqlite-s3/test/checkpoint.test.js
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { createManifestStore } from '../src/manifest.js';
import { encodePageImages } from '../src/page-images.js';
import { performCheckpoint } from '../src/checkpoint.js';

test('performCheckpoint does nothing when there are no wal segments to merge', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  await manifestStore.write({ baseSegmentId: null, walSegmentIds: [], pageSize: 16 }, { expectedEtag: null });

  const result = await performCheckpoint({ manifestStore, segmentStore });
  assert.equal(result.checkpointed, false);
});

test('performCheckpoint merges wal segments into a new base and clears walSegmentIds', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const pageSize = 16;
  const baseBytes = Buffer.alloc(pageSize, 0x00);
  const baseSegmentId = await segmentStore.putSegment(baseBytes);
  const walSegmentId = await segmentStore.putSegment(
    encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0xff) }]),
    { dbSizeAfterCommit: 1 }
  );
  await manifestStore.write(
    { baseSegmentId, walSegmentIds: [walSegmentId], pageSize },
    { expectedEtag: null }
  );

  const result = await performCheckpoint({ manifestStore, segmentStore });
  assert.equal(result.checkpointed, true);

  const { manifest } = await manifestStore.read();
  assert.deepEqual(manifest.walSegmentIds, []);
  assert.notEqual(manifest.baseSegmentId, baseSegmentId, 'must point at a NEW base segment');

  const newBase = await segmentStore.getSegment(manifest.baseSegmentId);
  assert.ok(newBase.bytes.every((b) => b === 0xff), 'new base reflects the merged wal segment');
});

test('performCheckpoint abandons silently on a manifest CAS conflict', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const realManifestStore = createManifestStore(store);
  const pageSize = 16;
  await realManifestStore.write(
    { baseSegmentId: null, walSegmentIds: [await segmentStore.putSegment(
      encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0x01) }]),
      { dbSizeAfterCommit: 1 }
    )], pageSize },
    { expectedEtag: null }
  );

  // Simulate another writer landing a segment between our read and our write:
  // read() returns the real (stale-by-the-time-we-write) manifest, but write()
  // always fails as if someone else already advanced the manifest.
  const { manifest: staleManifest, etag: staleEtag } = await realManifestStore.read();
  const conflictingManifestStore = {
    read: async () => ({ manifest: staleManifest, etag: staleEtag }),
    write: async () => {
      const err = new Error('manifest changed since last read');
      err.name = 'ManifestConflictError';
      err.current = await realManifestStore.read();
      throw err;
    },
  };

  const result = await performCheckpoint({ manifestStore: conflictingManifestStore, segmentStore });
  assert.equal(result.checkpointed, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/checkpoint.test.js
```

Expected: FAIL — `performCheckpoint` is not exported yet.

- [ ] **Step 3: Add performCheckpoint to checkpoint.js**

Add this to the top of `phase2/packages/sqlite-s3/src/checkpoint.js` (imports) and this new function anywhere after the existing `createCheckpointPolicy` export — do not modify `createCheckpointPolicy` itself:

```js
import { buildMergedFileBytes } from './merge.js';

export async function performCheckpoint({ manifestStore, segmentStore }) {
  const { manifest, etag } = await manifestStore.read();
  if (!manifest || !manifest.walSegmentIds || manifest.walSegmentIds.length === 0) {
    return { checkpointed: false };
  }

  const mergedBytes = await buildMergedFileBytes({ manifest, segmentStore });
  const newBaseId = await segmentStore.putSegment(mergedBytes);
  const nextManifest = {
    baseSegmentId: newBaseId,
    walSegmentIds: [],
    pageSize: manifest.pageSize,
  };

  try {
    await manifestStore.write(nextManifest, { expectedEtag: etag });
    return { checkpointed: true };
  } catch (err) {
    if (err.name !== 'ManifestConflictError') throw err;
    // Another writer landed a segment mid-merge — abandon this attempt.
    // Best-effort: the trigger policy fires again later.
    return { checkpointed: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd phase2/packages/sqlite-s3 && node --test test/checkpoint.test.js
```

Expected: PASS, 8 tests (5 pre-existing `createCheckpointPolicy` tests + 3 new).

- [ ] **Step 5: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/checkpoint.js test/checkpoint.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: add performCheckpoint, reusing merge.js

Merges the current manifest's full history (base + every wal segment,
from every writer — not just the checkpointing writer's own local
state) into a new base segment via a CAS-guarded manifest update.
Abandons silently on a CAS conflict — checkpointing is a best-effort
optimization, not correctness-critical, and the trigger policy will
fire again later. createCheckpointPolicy is unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

### Task 3: knex-client.js — wire checkpointing into commit capture

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/knex-client.js`
- Modify: `phase2/packages/sqlite-s3/test/knex-client.test.js`

**Interfaces:**
- Consumes: `performCheckpoint` from `./checkpoint.js` (Task 2); existing `checkpointPolicy.shouldCheckpoint()`/`recordCheckpoint()` (already exist, already unused until now).
- Produces: no new exports — `SqliteS3Client`'s public shape is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `phase2/packages/sqlite-s3/test/knex-client.test.js`:

```js
// Append to phase2/packages/sqlite-s3/test/knex-client.test.js
test('a checkpoint runs when the policy says to, and merges accumulated commits into a new base segment', async () => {
  const store = createInMemoryObjectStore();
  const dbPathA = await tmpDbPath();

  // A checkpoint policy that says "checkpoint" as soon as ANY bytes have
  // been recorded, so this test doesn't depend on real size/time thresholds.
  const manifestStore = createManifestStore(store);
  const segmentStore = createSegmentStore(store);
  let recorded = 0;
  const checkpointPolicy = {
    recordSegment: (n) => { recorded += n; },
    shouldCheckpoint: () => recorded > 0,
    recordCheckpoint: () => { recorded = 0; },
  };

  const knexA = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPathA, s3: { manifestStore, segmentStore, checkpointPolicy } },
    useNullAsDefault: true,
  });
  await knexA.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
  });
  await knexA('posts').insert({ title: 'hello' });
  await knexA.destroy();

  const { manifest } = await manifestStore.read();
  assert.ok(manifest.baseSegmentId, 'a base segment must exist after a checkpoint ran');
  assert.deepEqual(manifest.walSegmentIds, [], 'wal segments must be cleared after checkpointing');

  // Data must still be intact after the checkpoint, from a fresh instance.
  const dbPathB = await tmpDbPath();
  const knexB = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPathB, s3: { manifestStore, segmentStore, checkpointPolicy: makeS3Config(store).checkpointPolicy } },
    useNullAsDefault: true,
  });
  const rows = await knexB('posts').select('*');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'hello');
  await knexB.destroy();
});

test('a checkpoint failure does not break the caller\'s actual write', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const segmentStore = createSegmentStore(store);
  const manifestStore = {
    read: async () => { throw new Error('boom: simulated checkpoint read failure'); },
    write: createManifestStore(store).write,
  };
  const checkpointPolicy = {
    recordSegment: () => {},
    shouldCheckpoint: () => true, // always try to checkpoint
    recordCheckpoint: () => {},
  };

  // Use a SEPARATE, working manifestStore for the actual commit path, and only
  // make performCheckpoint's own read() call fail — simulate this by using a
  // real manifestStore for commits but asserting the write still succeeds
  // even though checkpointing will throw internally when it tries to read.
  const realManifestStore = createManifestStore(store);
  const knex = knexFactory({
    client: SqliteS3Client,
    connection: {
      filename: dbPath,
      s3: {
        manifestStore: realManifestStore,
        segmentStore,
        checkpointPolicy: {
          recordSegment: () => {},
          shouldCheckpoint: () => { throw new Error('boom: simulated checkpoint policy failure'); },
          recordCheckpoint: () => {},
        },
      },
    },
    useNullAsDefault: true,
  });

  await knex.schema.createTable('posts', (t) => {
    t.increments('id');
  });
  // If checkpoint wiring isn't wrapped in try/catch, this insert would reject.
  await knex('posts').insert({});
  const rows = await knex('posts').select('*');
  assert.equal(rows.length, 1);
  await knex.destroy();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js
```

Expected: FAIL — the first new test fails because no checkpoint ever runs (manifest has no baseSegmentId, walSegmentIds is non-empty instead of `[]`).

- [ ] **Step 3: Wire performCheckpoint into `_maybeCaptureCommit`**

In `phase2/packages/sqlite-s3/src/knex-client.js`, add the import:

```js
import { performCheckpoint } from './checkpoint.js';
```

Then replace this line near the end of `_maybeCaptureCommit`:

```js
    s3.checkpointPolicy.recordSegment(payload.length);
```

with:

```js
    s3.checkpointPolicy.recordSegment(payload.length);

    // Checkpointing is a best-effort optimization (bounds restore time by
    // periodically merging the growing wal-segment history into a new base
    // segment) — never let a failure here break the caller's actual write.
    try {
      if (s3.checkpointPolicy.shouldCheckpoint()) {
        const result = await performCheckpoint({
          manifestStore: s3.manifestStore,
          segmentStore: s3.segmentStore,
        });
        if (result.checkpointed) {
          s3.checkpointPolicy.recordCheckpoint();
        }
      }
    } catch (err) {
      console.error('sqlite-s3: checkpoint attempt failed (non-fatal):', err);
    }
```

- [ ] **Step 4: Run test to verify it passes, then the full suite**

```bash
cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js
```

Expected: PASS, 7 tests (5 pre-existing + 2 new).

```bash
cd phase2/packages/sqlite-s3 && npm test
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/knex-client.js test/knex-client.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: wire performCheckpoint into commit capture

After a successful commit, if checkpointPolicy.shouldCheckpoint() says
so, run performCheckpoint() and record it on success. Wrapped in
try/catch — checkpointing is a best-effort optimization and must never
fail the caller's actual write. checkpointPolicy.recordSegment()/
shouldCheckpoint()/recordCheckpoint() were built in an earlier task and
are finally used here.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

### Task 4: knex-client.js — transaction reconciliation

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/knex-client.js`
- Modify: `phase2/packages/sqlite-s3/test/knex-client.test.js`

**Interfaces:**
- Consumes: Knex's own connection-disposal convention — setting `connection.__knex__disposed = <any truthy value>` marks a pooled connection as invalid, so the pool discards it and creates a fresh one via `acquireRawConnection()` on the next acquire (this is not something this package invented — it's an existing internal Knex mechanism already used by Knex's own SQLite transaction handling and several other dialects; verify this is really how it behaves in the installed Knex version before relying on it — see Step 1 below).
- Produces: `SqliteS3Client` gains an overridden `transaction(container, config, outerTx)` method. No change to its public shape otherwise.

This is the task with a real, verifiable-before-you-build-on-it assumption: that setting `connection.__knex__disposed` on the connection used by a failed transaction actually causes the NEXT `.transaction()` call to go through `acquireRawConnection()` again (which is what re-restores from S3). Confirm this for real before writing the retry loop around it.

- [ ] **Step 1: Verify the disposal-forces-reacquire mechanism for real**

```bash
cd phase2/packages/sqlite-s3 && node -e "
const knex = require('knex');
console.log('knex version:', require('knex/package.json').version);
" 2>&1 | cat
```

Then read `node_modules/knex/lib/client.js` around the `connectionIsDisposed` helper (search for that exact string) to see how it's actually consulted during acquisition — confirm it's checked when handing out a connection from the pool (not just logged and ignored). Write a small standalone throwaway script (not a committed test) that: creates a `SqliteS3Client`-backed Knex instance, acquires a connection, sets `connection.__knex__disposed = new Error('test')` on it, releases it back to the pool, then does something that would acquire a connection again (e.g. a query), and confirms — via a `console.log` inside a temporarily-added debug line in `acquireRawConnection`, or by checking that `restoreLocalDb` ran again (e.g. count calls) — that a FRESH connection was actually created (i.e. `acquireRawConnection()` ran again), not the same disposed one reused. Delete the throwaway script when done; this step's purpose is to confirm the mechanism, not to ship it.

If this verification does NOT confirm the expected behavior (disposal → forced re-acquire → `acquireRawConnection()` runs again), STOP and report BLOCKED with what you found — do not build the retry loop on an assumption that didn't hold. This is a case where being wrong here would silently make reconciliation a no-op (transactions would "retry" against the SAME diverged local state, which is worse than not retrying at all, since it could produce a confusing infinite-loop-until-max-attempts instead of a clean error).

- [ ] **Step 2: Write the failing test**

Append to `phase2/packages/sqlite-s3/test/knex-client.test.js`:

```js
// Append to phase2/packages/sqlite-s3/test/knex-client.test.js
test('a knex.transaction() callback is safely re-invoked against fresh state after losing a conflict race', async () => {
  const store = createInMemoryObjectStore();
  const manifestStore = createManifestStore(store);
  const segmentStore = createSegmentStore(store);
  const checkpointPolicy = createCheckpointPolicy({ maxWalBytes: 10_000_000, maxIntervalMs: 3_600_000 });
  const s3Config = { manifestStore, segmentStore, checkpointPolicy };

  const dbPath = await tmpDbPath();
  const knex = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: s3Config },
    useNullAsDefault: true,
  });
  await knex.schema.createTable('counters', (t) => {
    t.string('name').primary();
    t.integer('value');
  });
  await knex('counters').insert({ name: 'hits', value: 0 });

  // Simulate a losing conflict on the FIRST attempt only: monkey-patch
  // manifestStore.write to fail once with a conflict, then behave normally.
  let writeCallCount = 0;
  const realWrite = manifestStore.write.bind(manifestStore);
  manifestStore.write = async (manifest, opts) => {
    writeCallCount += 1;
    if (writeCallCount === 1) {
      // Force a conflict on the transaction's own commit by writing a
      // DIFFERENT, overlapping segment first, then let the real write proceed
      // (it will naturally conflict against what we just wrote).
      const conflictingSegId = await segmentStore.putSegment(
        (await import('../src/page-images.js')).encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(4096, 0) }]),
        { dbSizeAfterCommit: 1 }
      );
      const { manifest: current, etag: currentEtag } = await manifestStore.read
        ? await realManifestReadBeforePatch()
        : { manifest: null, etag: null };
    }
    return realWrite(manifest, opts);
  };

  let attemptCount = 0;
  const result = await knex.transaction(async (trx) => {
    attemptCount += 1;
    const row = await trx('counters').where({ name: 'hits' }).first();
    await trx('counters').where({ name: 'hits' }).update({ value: row.value + 1 });
    return row.value + 1;
  });

  assert.ok(attemptCount >= 1, 'the callback must have run');
  const finalRow = await knex('counters').where({ name: 'hits' }).first();
  assert.equal(finalRow.value, 1, 'exactly one increment must be reflected, not zero or double-counted');
  await knex.destroy();
});
```

**A note on this test as written:** the exact mechanics of forcing a realistic conflict on a transaction's own commit (as opposed to a bare autocommit statement, which earlier tasks already tested conflict-handling for) may need adjustment once you're working with the real code — the sketch above gestures at "make the first manifest write attempt lose a race" but you will likely find a cleaner way once Step 1's verification script has shown you exactly how the disposal/reacquire mechanism behaves in practice. The REQUIRED properties of whatever test you end up with are: (a) it exercises a REAL `knex.transaction(fn)` call whose underlying commit genuinely loses a CAS race at least once, (b) the callback's logic actually re-runs against fresh state rather than the transaction just failing outright, (c) the final result reflects exactly one successful increment, not zero (retry silently swallowed) and not two (double-applied). If the sketch's mocking approach proves awkward, restructure it — e.g. by having a SEPARATE writer commit a real conflicting change to the same page between the transaction's local commit and its manifest CAS attempt, using two real `SqliteS3Client` instances race-style, whichever is more reliable to construct. Use your judgment; the assertions in (a)-(c) are the actual requirement, not the literal mock code above.

- [ ] **Step 3: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js
```

Expected: FAIL — no `transaction()` override exists yet, so a conflict just rejects the whole `knex.transaction()` call.

- [ ] **Step 4: Implement the fix**

In `phase2/packages/sqlite-s3/src/knex-client.js`:

Change `_maybeCaptureCommit`'s signature to accept the connection (it's already passed by its one caller in `_query`, just not currently declared):

```js
  async _maybeCaptureCommit(connection) {
```

Update the `outcome.retryTransaction` branch to tag the error and mark the connection disposed, so the next connection acquire re-restores from S3:

```js
    if (outcome.retryTransaction) {
      // By this point the write has already committed locally — there is no
      // local transaction left to "retry" as itself. This writer's local
      // state has now diverged from the shared history; do NOT advance
      // _lastWalOffset, so the next successful capture naturally
      // re-includes these bytes (plus whatever accumulates after) in one
      // larger delta/segment.
      const err = new Error(
        "sqlite-s3: local write committed but lost an optimistic-concurrency race shipping to S3 — this writer's local state has diverged from the shared history"
      );
      // Tag so `transaction()` below knows this is a safe-to-retry conflict,
      // not an arbitrary error the caller should just see.
      err.sqliteS3Conflict = true;
      // Mark the connection disposed so Knex's pool discards it and the next
      // acquire runs acquireRawConnection() again, which restores fresh
      // state from S3 — this is an existing Knex convention (used
      // internally by Knex's own dialects), not something this package
      // invented; see Step 1's verification.
      if (connection) {
        connection.__knex__disposed = err;
      }
      throw err;
    }
```

Add the `transaction()` override as a new method on the class (after `_maybeCaptureCommit`):

```js
  async transaction(container, config, outerTx) {
    if (outerTx) {
      // Nested transactions (savepoints) share the parent's connection —
      // retrying by discarding and reacquiring a connection would break
      // savepoint semantics. Reconciliation only applies to top-level
      // transactions.
      return super.transaction(container, config, outerTx);
    }
    const MAX_RECONCILE_ATTEMPTS = 10;
    let lastErr;
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
      try {
        return await super.transaction(container, config, outerTx);
      } catch (err) {
        if (!err.sqliteS3Conflict) throw err;
        lastErr = err;
        // The connection was marked __knex__disposed when the conflict was
        // detected (see _maybeCaptureCommit), so the retried
        // super.transaction() call below will acquire a fresh connection —
        // re-running restoreLocalDb against the now-current S3 state —
        // before re-invoking `container` against that fresh state.
      }
    }
    throw lastErr;
  }
```

- [ ] **Step 5: Run test to verify it passes, then the full suite**

```bash
cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js
```

Expected: PASS.

```bash
cd phase2/packages/sqlite-s3 && npm test
```

Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/knex-client.js test/knex-client.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: add transaction() reconciliation for knex.transaction() writes

On a conflict, _maybeCaptureCommit now marks the connection
__knex__disposed (an existing Knex convention, verified against the
installed version) so the pool discards it and the next acquire
restores fresh state from S3. A new transaction() override catches the
tagged conflict error and re-invokes the caller's own callback against
that fresh state, up to 10 attempts — matching the existing commit
retry budget. Scoped to top-level transactions only; nested
transactions (savepoints) and bare autocommit writes are unaffected,
per the design doc's documented scope.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** checkpoint merge-logic reuse (Task 1 + 2), checkpoint wiring into commit capture (Task 3), and transaction reconciliation scoped to `knex.transaction()` (Task 4) — every part of the spec's "Checkpointing → Implementation" and "Conflict reconciliation" sections maps to a task.
- **Placeholder scan:** no TBD/TODO. Task 4's test sketch is explicitly flagged as needing adjustment during implementation (a real, deliberate exception to "no placeholders," not a hidden gap) — but the three REQUIRED properties any replacement test must satisfy are stated concretely, not left vague, and Task 4's Step 1 requires verifying the load-bearing assumption for real before building on it.
- **Type/name consistency:** `buildMergedFileBytes({manifest, segmentStore})` used identically in Task 1, 2. `performCheckpoint({manifestStore, segmentStore}) -> {checkpointed}` used identically in Task 2, 3. `connection.__knex__disposed` and `err.sqliteS3Conflict` are the two pieces of new state Task 4 introduces, used consistently within that task.
- **Scope discipline:** bare-autocommit reconciliation is explicitly out of scope (documented in the spec, restated in Global Constraints) — no task attempts it. Nested-transaction reconciliation is explicitly out of scope for the same reason (savepoint semantics) — Task 4 delegates those straight to `super.transaction()`.
