# Checkpoint Race Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `performCheckpoint` converge under continuous single-process writes without leaking segments, and reclaim superseded segments safely against readers mid-restore.

**Architecture:** Bounded-retry checkpoint that folds only newly-landed WAL segments onto its already-built merge on each retry (instead of discarding and re-merging), deletes its own losing attempts immediately, and reclaims the segments it supersedes inline — gated by a small lease mechanism that lets a booting process (`restoreLocalDb`) mark exactly which segment ids it's still fetching, so a concurrent checkpoint's reclamation skips those ids. A standalone script reuses the same lease-safety check to sweep the existing orphan backlog and can be re-run periodically as a safety net for any inline reclamation a lease deferred.

**Tech Stack:** Node.js (`node:test`, `node:assert/strict`), existing `sqlite-s3` package conventions (in-memory + S3 object store implementations tested identically).

**Spec:** `docs/superpowers/specs/2026-09-10-checkpoint-race-fix-design.md`

## Global Constraints

- No further content migration; must be safe to deploy against a store already holding a large orphaned backlog (moth `zwx7x`).
- Must not reintroduce a global lock — multiple writers remain a supported design point of the store.
- The race must be reproduced by a test (a real competing commit landing mid-checkpoint) before being fixed — not asserted by inspection alone.
- All new internal dependencies (`leaseStore`, `etag`/`manifest` snapshots) are required parameters, not optional-with-silent-fallback, matching this package's existing style (`manifestStore`/`segmentStore` are never defaulted).
- Default checkpoint retry cap: 5 attempts. Default lease TTL: 5 minutes (`5 * 60_000` ms). Both overridable via function options.
- The one-time backlog cleanup is a standalone script, defaults to a dry run, and is never executed directly against production by an agent — it's packaged for the user to run.

---

### Task 1: Object store `delete` and `list`

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/object-store.js`
- Test: `phase2/packages/sqlite-s3/test/object-store.test.js`

**Interfaces:**
- Produces: `store.delete(key)` → `Promise<void>`, idempotent (resolves even if the key doesn't exist). `store.list(prefix)` → `Promise<string[]>`, full keys (not stripped of prefix) matching the given prefix.

- [ ] **Step 1: Write the failing tests**

Append to `test/object-store.test.js`:

```js
test('delete then get rejects with NotFound', async () => {
  const store = createInMemoryObjectStore();
  await store.put('k', Buffer.from('a'));
  await store.delete('k');
  await assert.rejects(() => store.get('k'), (err) => err.code === 'NotFound');
});

test('delete on a missing key does not throw', async () => {
  const store = createInMemoryObjectStore();
  await store.delete('never-existed');
});

test('list returns only keys matching the prefix', async () => {
  const store = createInMemoryObjectStore();
  await store.put('segments/a.seg', Buffer.from('a'));
  await store.put('segments/b.seg', Buffer.from('b'));
  await store.put('leases/c', Buffer.from('c'));
  const keys = await store.list('segments/');
  assert.deepEqual(keys.sort(), ['segments/a.seg', 'segments/b.seg']);
});

test('S3-backed store delete maps a 404 to a no-op', async () => {
  const fakeClient = {
    async send() {
      const err = new Error('NoSuchKey');
      err.name = 'NoSuchKey';
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    },
  };
  const store = createS3ObjectStore({ bucket: 'test-bucket', client: fakeClient });
  await store.delete('missing');
});

test('S3-backed store delete rethrows unrelated errors', async () => {
  const fakeClient = {
    async send() {
      const err = new Error('boom');
      err.$metadata = { httpStatusCode: 500 };
      throw err;
    },
  };
  const store = createS3ObjectStore({ bucket: 'test-bucket', client: fakeClient });
  await assert.rejects(() => store.delete('k'), (err) => err.message === 'boom');
});

test('S3-backed store list pages through ListObjectsV2 continuation tokens', async () => {
  const calls = [];
  const fakeClient = {
    async send(command) {
      calls.push(command.input);
      if (!command.input.ContinuationToken) {
        return { Contents: [{ Key: 'segments/a.seg' }], IsTruncated: true, NextContinuationToken: 'tok-2' };
      }
      return { Contents: [{ Key: 'segments/b.seg' }], IsTruncated: false };
    },
  };
  const store = createS3ObjectStore({ bucket: 'test-bucket', client: fakeClient });
  const keys = await store.list('segments/');
  assert.deepEqual(keys, ['segments/a.seg', 'segments/b.seg']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].ContinuationToken, 'tok-2');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd phase2/packages/sqlite-s3 && node --test test/object-store.test.js`
Expected: FAIL — `store.delete is not a function` / `store.list is not a function`.

- [ ] **Step 3: Implement `delete` and `list`**

In `src/object-store.js`, update the S3 SDK import and add the two operations to both stores:

```js
import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
```

In `createInMemoryObjectStore()`, add alongside `get`/`put`:

```js
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix));
    },
```

In `createS3ObjectStore(...)`, add alongside `get`/`put`:

```js
    async delete(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return;
        throw err;
      }
    },
    async list(prefix) {
      const keys = [];
      let continuationToken;
      do {
        const res = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }));
        for (const obj of res.Contents ?? []) keys.push(obj.Key);
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd phase2/packages/sqlite-s3 && node --test test/object-store.test.js`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add phase2/packages/sqlite-s3/src/object-store.js phase2/packages/sqlite-s3/test/object-store.test.js
git commit -m "sqlite-s3: add delete and list to the object store"
```

---

### Task 2: `segmentStore.deleteSegment`

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/segments.js`
- Test: `phase2/packages/sqlite-s3/test/segments.test.js`

**Interfaces:**
- Consumes: `store.delete(key)` from Task 1.
- Produces: `segmentStore.deleteSegment(id)` → `Promise<void>`.

- [ ] **Step 1: Write the failing test**

Append to `test/segments.test.js`:

```js
test('deleteSegment removes it so getSegment rejects with NotFound', async () => {
  const store = createSegmentStore(createInMemoryObjectStore());
  const id = await store.putSegment(Buffer.from('gone-soon'));
  await store.deleteSegment(id);
  await assert.rejects(() => store.getSegment(id), (err) => err.code === 'NotFound');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd phase2/packages/sqlite-s3 && node --test test/segments.test.js`
Expected: FAIL — `store.deleteSegment is not a function`.

- [ ] **Step 3: Implement `deleteSegment`**

In `src/segments.js`, add to the returned object:

```js
    async deleteSegment(id) {
      await store.delete(`segments/${id}.seg`);
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd phase2/packages/sqlite-s3 && node --test test/segments.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add phase2/packages/sqlite-s3/src/segments.js phase2/packages/sqlite-s3/test/segments.test.js
git commit -m "sqlite-s3: add segmentStore.deleteSegment"
```

---

### Task 3: Reader leases (`leases.js`)

**Files:**
- Create: `phase2/packages/sqlite-s3/src/leases.js`
- Test: `phase2/packages/sqlite-s3/test/leases.test.js`

**Interfaces:**
- Consumes: `objectStore.put/get/delete/list` from Task 1.
- Produces: `createLeaseStore(objectStore)` → `{ acquire(manifest, { ttlMs, now? }), listActiveSegmentIds(now?) }`. `acquire` returns `{ key, refresh(ttlMs, now?), release() }`. A lease records the exact `manifest` snapshot (`{ baseSegmentId, walSegmentIds }`) the caller is reading from — not just an opaque generation id — so `listActiveSegmentIds` can report the concrete segment ids still in use by any live lease, without needing to retrieve a historical manifest body that the object store doesn't retain.

- [ ] **Step 1: Write the failing tests**

Create `test/leases.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createLeaseStore } from '../src/leases.js';

test('a fresh lease reports its manifest\'s segment ids as active', async () => {
  const leaseStore = createLeaseStore(createInMemoryObjectStore());
  const manifest = { baseSegmentId: 'base-1', walSegmentIds: ['wal-1', 'wal-2'] };
  await leaseStore.acquire(manifest, { ttlMs: 60_000, now: 0 });
  const active = await leaseStore.listActiveSegmentIds(0);
  assert.deepEqual([...active].sort(), ['base-1', 'wal-1', 'wal-2']);
});

test('a lease past its TTL is excluded', async () => {
  const leaseStore = createLeaseStore(createInMemoryObjectStore());
  const manifest = { baseSegmentId: 'base-1', walSegmentIds: [] };
  await leaseStore.acquire(manifest, { ttlMs: 1000, now: 0 });
  const active = await leaseStore.listActiveSegmentIds(1001);
  assert.equal(active.size, 0);
});

test('release removes the lease so its segments no longer show as active', async () => {
  const leaseStore = createLeaseStore(createInMemoryObjectStore());
  const manifest = { baseSegmentId: 'base-1', walSegmentIds: [] };
  const lease = await leaseStore.acquire(manifest, { ttlMs: 60_000, now: 0 });
  await lease.release();
  const active = await leaseStore.listActiveSegmentIds(0);
  assert.equal(active.size, 0);
});

test('refresh extends the lease past its original expiry', async () => {
  const leaseStore = createLeaseStore(createInMemoryObjectStore());
  const manifest = { baseSegmentId: 'base-1', walSegmentIds: [] };
  const lease = await leaseStore.acquire(manifest, { ttlMs: 1000, now: 0 });
  await lease.refresh(1000, 900);
  const active = await leaseStore.listActiveSegmentIds(1500);
  assert.equal(active.size, 1);
});

test('listActiveSegmentIds tolerates a lease deleted between listing and reading it', async () => {
  const store = createInMemoryObjectStore();
  const leaseStore = createLeaseStore(store);
  const manifest = { baseSegmentId: 'base-1', walSegmentIds: [] };
  const lease = await leaseStore.acquire(manifest, { ttlMs: 60_000, now: 0 });
  const realGet = store.get.bind(store);
  store.get = async (key) => {
    if (key === lease.key) {
      const err = new Error('gone');
      err.code = 'NotFound';
      throw err;
    }
    return realGet(key);
  };
  const active = await leaseStore.listActiveSegmentIds(0);
  assert.equal(active.size, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd phase2/packages/sqlite-s3 && node --test test/leases.test.js`
Expected: FAIL — cannot find module `../src/leases.js`.

- [ ] **Step 3: Implement `leases.js`**

Create `src/leases.js`:

```js
import { randomUUID } from 'node:crypto';

const LEASE_PREFIX = 'leases/';

export function createLeaseStore(objectStore) {
  async function writeLease(key, manifest, ttlMs, now) {
    const bytes = Buffer.from(JSON.stringify({ manifest, expiresAt: now + ttlMs }));
    await objectStore.put(key, bytes);
  }

  return {
    async acquire(manifest, { ttlMs, now = Date.now() }) {
      const key = `${LEASE_PREFIX}${randomUUID()}`;
      await writeLease(key, manifest, ttlMs, now);
      return {
        key,
        async refresh(refreshTtlMs, refreshNow = Date.now()) {
          await writeLease(key, manifest, refreshTtlMs, refreshNow);
        },
        async release() {
          await objectStore.delete(key);
        },
      };
    },

    async listActiveSegmentIds(now = Date.now()) {
      const keys = await objectStore.list(LEASE_PREFIX);
      const ids = new Set();
      for (const key of keys) {
        let lease;
        try {
          const { bytes } = await objectStore.get(key);
          lease = JSON.parse(bytes.toString('utf8'));
        } catch (err) {
          if (err.code === 'NotFound') continue; // released between list() and get()
          throw err;
        }
        if (lease.expiresAt <= now) continue;
        if (lease.manifest?.baseSegmentId) ids.add(lease.manifest.baseSegmentId);
        for (const id of lease.manifest?.walSegmentIds ?? []) ids.add(id);
      }
      return ids;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd phase2/packages/sqlite-s3 && node --test test/leases.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add phase2/packages/sqlite-s3/src/leases.js phase2/packages/sqlite-s3/test/leases.test.js
git commit -m "sqlite-s3: add reader lease store for safe segment reclamation"
```

---

### Task 4: Extract reusable fold/truncate helpers in `merge.js`

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/merge.js`
- Test: `phase2/packages/sqlite-s3/test/merge.test.js`

**Interfaces:**
- Produces: `foldWalSegments({ fileBytes, finalPageCount, walSegmentIds, segmentStore, pageSize })` → `Promise<{ fileBytes, finalPageCount }>` (folds the given WAL segments onto `fileBytes`, growing it as needed, and returns the updated buffer plus the running max `dbSizeAfterCommit`). `truncateToPageCount(fileBytes, finalPageCount, pageSize)` → `Buffer` (unchanged if `finalPageCount` is 0, else truncated to `finalPageCount * pageSize`). `buildMergedFileBytes` keeps its existing signature and behavior, now implemented in terms of these two.
- Consumed by: Task 6 (`checkpoint.js`'s incremental retry).

- [ ] **Step 1: Write the failing tests**

Append to `test/merge.test.js`:

```js
import { foldWalSegments, truncateToPageCount } from '../src/merge.js';

test('foldWalSegments overlays a wal segment onto existing bytes and tracks the max dbSizeAfterCommit', async () => {
  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const pageSize = 16;
  const walSegmentId = await segmentStore.putSegment(
    encodePageImages([{ pageNumber: 2, bytes: Buffer.alloc(pageSize, 0xbb) }]),
    { dbSizeAfterCommit: 2 }
  );
  const { fileBytes, finalPageCount } = await foldWalSegments({
    fileBytes: Buffer.alloc(pageSize, 0x00),
    finalPageCount: 1,
    walSegmentIds: [walSegmentId],
    segmentStore,
    pageSize,
  });
  assert.equal(fileBytes.length, pageSize * 2, 'must grow to fit the new page');
  assert.ok(fileBytes.subarray(pageSize, pageSize * 2).every((b) => b === 0xbb));
  assert.equal(finalPageCount, 2);
});

test('foldWalSegments with an empty list is a no-op', async () => {
  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const original = Buffer.from('unchanged');
  const { fileBytes, finalPageCount } = await foldWalSegments({
    fileBytes: original,
    finalPageCount: 0,
    walSegmentIds: [],
    segmentStore,
    pageSize: 16,
  });
  assert.equal(fileBytes, original);
  assert.equal(finalPageCount, 0);
});

test('truncateToPageCount truncates when finalPageCount is positive', () => {
  const bytes = Buffer.alloc(32, 0x01);
  const truncated = truncateToPageCount(bytes, 1, 16);
  assert.equal(truncated.length, 16);
});

test('truncateToPageCount returns the input unchanged when finalPageCount is 0', () => {
  const bytes = Buffer.alloc(32, 0x01);
  const truncated = truncateToPageCount(bytes, 0, 16);
  assert.equal(truncated, bytes);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd phase2/packages/sqlite-s3 && node --test test/merge.test.js`
Expected: FAIL — `foldWalSegments`/`truncateToPageCount` are not exported.

- [ ] **Step 3: Refactor `merge.js`**

Replace the full contents of `src/merge.js`:

```js
import { decodePageImages } from './page-images.js';

export async function foldWalSegments({ fileBytes, finalPageCount, walSegmentIds, segmentStore, pageSize }) {
  let bytes = fileBytes;
  let pageCount = finalPageCount;

  for (const walSegmentId of walSegmentIds) {
    const seg = await segmentStore.getSegment(walSegmentId);
    const pages = decodePageImages(seg.bytes);
    for (const { pageNumber, bytes: pageBytes } of pages) {
      const endOffset = pageNumber * pageSize;
      if (endOffset > bytes.length) {
        const grown = Buffer.alloc(endOffset);
        bytes.copy(grown);
        bytes = grown;
      }
      pageBytes.copy(bytes, (pageNumber - 1) * pageSize);
    }
    if (seg.meta?.dbSizeAfterCommit) {
      pageCount = Math.max(pageCount, seg.meta.dbSizeAfterCommit);
    }
  }

  return { fileBytes: bytes, finalPageCount: pageCount };
}

export function truncateToPageCount(fileBytes, finalPageCount, pageSize) {
  if (finalPageCount > 0) {
    return fileBytes.subarray(0, finalPageCount * pageSize);
  }
  return fileBytes;
}

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
  const initialPageCount = pageSize > 0 ? Math.floor(fileBytes.length / pageSize) : 0;

  const { fileBytes: folded, finalPageCount } = await foldWalSegments({
    fileBytes,
    finalPageCount: initialPageCount,
    walSegmentIds: manifest.walSegmentIds ?? [],
    segmentStore,
    pageSize,
  });

  return truncateToPageCount(folded, finalPageCount, pageSize);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd phase2/packages/sqlite-s3 && node --test test/merge.test.js test/restore.test.js`
Expected: PASS — the refactor must not change `buildMergedFileBytes`'s behavior, so `restore.test.js` (which exercises it indirectly) must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add phase2/packages/sqlite-s3/src/merge.js phase2/packages/sqlite-s3/test/merge.test.js
git commit -m "sqlite-s3: extract foldWalSegments/truncateToPageCount from buildMergedFileBytes"
```

---

### Task 5: `restore.js` acquires a lease around the fetch-and-merge

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/restore.js`
- Test: `phase2/packages/sqlite-s3/test/restore.test.js`

**Interfaces:**
- Consumes: `createLeaseStore` from Task 3 (`leases.js`).
- Produces: `restoreLocalDb({ manifest, segmentStore, leaseStore, dbPath, leaseTtlMs? })` — `leaseStore` is now a required parameter. Drops nothing from the existing signature except that `leaseStore` must now be passed; behavior and output for a given manifest/segmentStore/dbPath are unchanged.

- [ ] **Step 1: Update existing tests and write the new one**

In `test/restore.test.js`, add the import:

```js
import { createLeaseStore } from '../src/leases.js';
```

Add `leaseStore: createLeaseStore(<the same underlying object store used by that test's segmentStore>)` to every existing `restoreLocalDb({...})` call in the file. Concretely, each test currently does `const segmentStore = createSegmentStore(createInMemoryObjectStore());` — change this to keep the object store in a variable so the lease store can share it:

```js
const objectStore = createInMemoryObjectStore();
const segmentStore = createSegmentStore(objectStore);
const leaseStore = createLeaseStore(objectStore);
```

then pass `leaseStore` into each `restoreLocalDb({ manifest, segmentStore, leaseStore, dbPath })` call in that test. Apply this to all seven existing tests in the file (the null-manifest test, the two basic restore tests, the two-writer composition test — note it uses two separate `segmentStore`s, `preSegmentStore` and `segmentStore`, each needs its own `leaseStore` built from its own object store — the C-A truncation test, and the two error-path tests).

Then append two new tests:

```js
test('restoreLocalDb acquires a lease for the duration of the restore and releases it after', async () => {
  const objectStore = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);
  const pageSize = 16;
  const baseSegmentId = await segmentStore.putSegment(Buffer.alloc(pageSize, 0x00));
  const manifest = { baseSegmentId, walSegmentIds: [], pageSize };

  let activeDuringRestore;
  const originalGetSegment = segmentStore.getSegment.bind(segmentStore);
  segmentStore.getSegment = async (id) => {
    activeDuringRestore = await leaseStore.listActiveSegmentIds();
    return originalGetSegment(id);
  };

  const dbPath = await tmpPath('lease-check.db');
  await restoreLocalDb({ manifest, segmentStore, leaseStore, dbPath });

  assert.ok(activeDuringRestore.has(baseSegmentId), 'a lease must be active while segments are being fetched');
  assert.equal((await leaseStore.listActiveSegmentIds()).size, 0, 'the lease must be released once restore completes');
});

test('restoreLocalDb releases its lease even when the merge throws (I-B)', async () => {
  const objectStore = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);
  const walSegmentId = await segmentStore.putSegment(Buffer.from('irrelevant'), { dbSizeAfterCommit: 1 });
  const manifest = { baseSegmentId: null, walSegmentIds: [walSegmentId], pageSize: undefined };

  const dbPath = await tmpPath('lease-release-on-error.db');
  await assert.rejects(() => restoreLocalDb({ manifest, segmentStore, leaseStore, dbPath }));
  assert.equal((await leaseStore.listActiveSegmentIds()).size, 0, 'a failed restore must not leak its lease');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd phase2/packages/sqlite-s3 && node --test test/restore.test.js`
Expected: FAIL — `leaseStore.acquire is not a function` (restore.js doesn't call it yet), or the new lease-tracking assertions fail.

- [ ] **Step 3: Implement the lease acquisition in `restore.js`**

Replace `src/restore.js`:

```js
import { rm, writeFile } from 'node:fs/promises';
import { buildMergedFileBytes } from './merge.js';

export async function restoreLocalDb({ manifest, segmentStore, leaseStore, dbPath, leaseTtlMs = 5 * 60_000 }) {
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });

  const hasWalSegments = manifest && manifest.walSegmentIds && manifest.walSegmentIds.length > 0;
  if (!manifest || (!manifest.baseSegmentId && !hasWalSegments)) {
    return; // truly nothing to restore — a fresh database
  }

  // A concurrent checkpoint can reclaim segments this manifest references
  // the moment it wins its own CAS. Holding a lease for the duration of the
  // fetch-and-merge tells that checkpoint's reclamation step these ids are
  // still in use, so it defers deleting them.
  const lease = await leaseStore.acquire(manifest, { ttlMs: leaseTtlMs });
  try {
    const fileBytes = await buildMergedFileBytes({ manifest, segmentStore });
    await writeFile(dbPath, fileBytes);
  } finally {
    await lease.release();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd phase2/packages/sqlite-s3 && node --test test/restore.test.js`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add phase2/packages/sqlite-s3/src/restore.js phase2/packages/sqlite-s3/test/restore.test.js
git commit -m "sqlite-s3: restoreLocalDb holds a reader lease while fetching segments"
```

---

### Task 6: `checkpoint.js` — bounded retry, incremental fold, delete-on-abandon, lease-gated reclamation

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/checkpoint.js`
- Test: `phase2/packages/sqlite-s3/test/checkpoint.test.js`

**Interfaces:**
- Consumes: `foldWalSegments`/`truncateToPageCount` (Task 4), `segmentStore.deleteSegment` (Task 2), `leaseStore.listActiveSegmentIds` (Task 3).
- Produces: `performCheckpoint({ manifestStore, segmentStore, leaseStore, maxRetries?, leaseTtlMs?, now?, onBeforeWrite? })` → `{ checkpointed: boolean }`. `leaseStore` is now required. `onBeforeWrite` is a test-only seam (default no-op), called with `{ attempt }` after this attempt's merged base segment is written to the store but before the manifest CAS — the exact window where a real competing commit can land in production.
- `createCheckpointPolicy` is unchanged.

- [ ] **Step 1: Update existing tests and write the new race-repro test**

Replace `test/checkpoint.test.js`'s two `performCheckpoint` tests and add new ones. Full new content for the `performCheckpoint`-related section of the file (the `createCheckpointPolicy` tests above it are unchanged):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpointPolicy, performCheckpoint } from '../src/checkpoint.js';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { createManifestStore } from '../src/manifest.js';
import { createLeaseStore } from '../src/leases.js';
import { createCommitter } from '../src/commit.js';
import { encodePageImages } from '../src/page-images.js';

// ... (existing createCheckpointPolicy tests unchanged) ...

test('performCheckpoint does nothing when there are no wal segments to merge', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
  await manifestStore.write({ baseSegmentId: null, walSegmentIds: [], pageSize: 16 }, { expectedEtag: null });

  const result = await performCheckpoint({ manifestStore, segmentStore, leaseStore });
  assert.equal(result.checkpointed, false);
});

test('performCheckpoint merges wal segments into a new base, clears walSegmentIds, and reclaims the old base + wal segment', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
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

  const result = await performCheckpoint({ manifestStore, segmentStore, leaseStore });
  assert.equal(result.checkpointed, true);

  const { manifest } = await manifestStore.read();
  assert.deepEqual(manifest.walSegmentIds, []);
  assert.notEqual(manifest.baseSegmentId, baseSegmentId, 'must point at a NEW base segment');

  const newBase = await segmentStore.getSegment(manifest.baseSegmentId);
  assert.ok(newBase.bytes.every((b) => b === 0xff), 'new base reflects the merged wal segment');

  await assert.rejects(() => segmentStore.getSegment(baseSegmentId), (err) => err.code === 'NotFound');
  await assert.rejects(() => segmentStore.getSegment(walSegmentId), (err) => err.code === 'NotFound');
});

test('performCheckpoint does not reclaim segments a live reader lease still references', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
  const pageSize = 16;
  const baseSegmentId = await segmentStore.putSegment(Buffer.alloc(pageSize, 0x00));
  const walSegmentId = await segmentStore.putSegment(
    encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0xff) }]),
    { dbSizeAfterCommit: 1 }
  );
  const { etag } = await manifestStore.write(
    { baseSegmentId, walSegmentIds: [walSegmentId], pageSize },
    { expectedEtag: null }
  );
  const { manifest: manifestBeingRestored } = await manifestStore.read();
  await leaseStore.acquire(manifestBeingRestored, { ttlMs: 60_000 });

  const result = await performCheckpoint({ manifestStore, segmentStore, leaseStore });
  assert.equal(result.checkpointed, true);

  const oldBase = await segmentStore.getSegment(baseSegmentId);
  assert.ok(oldBase, 'the old base must survive while a lease references it');
  const oldWal = await segmentStore.getSegment(walSegmentId);
  assert.ok(oldWal, 'the old wal segment must survive while a lease references it');
});

test('performCheckpoint retries and abandons after maxRetries under a permanent CAS conflict, leaking nothing', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const realManifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
  const pageSize = 16;
  await realManifestStore.write(
    { baseSegmentId: null, walSegmentIds: [await segmentStore.putSegment(
      encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0x01) }]),
      { dbSizeAfterCommit: 1 }
    )], pageSize },
    { expectedEtag: null }
  );

  // A manifestStore whose write() ALWAYS reports a conflict against the real,
  // unchanging manifest -- simulating a competitor that never actually lands
  // (so no amount of incremental folding can ever converge), to exercise the
  // retry cap and the delete-on-abandon path for every attempt.
  const conflictingManifestStore = {
    read: () => realManifestStore.read(),
    write: async () => {
      const err = new Error('manifest changed since last read');
      err.name = 'ManifestConflictError';
      err.current = await realManifestStore.read();
      throw err;
    },
  };

  const result = await performCheckpoint({
    manifestStore: conflictingManifestStore,
    segmentStore,
    leaseStore,
    maxRetries: 3,
  });
  assert.equal(result.checkpointed, false);

  const remaining = await store.list('segments/');
  assert.equal(remaining.length, 1, 'only the original wal segment may remain -- every abandoned attempt\'s base must be deleted');
});

test('performCheckpoint converges under a real commit landing mid-checkpoint, by folding it in on retry (race repro)', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
  const committer = createCommitter({ manifestStore, segmentStore });
  const pageSize = 16;

  const baseSegmentId = await segmentStore.putSegment(Buffer.alloc(pageSize, 0x00));
  const walSegmentId = await segmentStore.putSegment(
    encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0x11) }]),
    { dbSizeAfterCommit: 1 }
  );
  await manifestStore.write(
    { baseSegmentId, walSegmentIds: [walSegmentId], pageSize },
    { expectedEtag: null }
  );

  let landed = false;
  const result = await performCheckpoint({
    manifestStore,
    segmentStore,
    leaseStore,
    onBeforeWrite: async ({ attempt }) => {
      if (attempt !== 0 || landed) return;
      landed = true;
      // The exact production race: a real competing commit lands after this
      // checkpoint attempt has already built its merge, but before it wins
      // the manifest CAS.
      const baseline = await manifestStore.read();
      await committer.commitWalDelta(
        encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0x22) }]),
        [{ pageNumber: 1, dbSizeAfterCommit: 1 }],
        pageSize,
        baseline
      );
    },
  });

  assert.equal(result.checkpointed, true);
  const { manifest } = await manifestStore.read();
  assert.deepEqual(manifest.walSegmentIds, [], 'the retry must fold the racing commit in, not just lose to it');

  const newBase = await segmentStore.getSegment(manifest.baseSegmentId);
  assert.equal(newBase.bytes[0], 0x22, 'the racing commit\'s page must be present in the winning base');

  const remaining = await store.list('segments/');
  assert.equal(remaining.length, 1, 'the old base, old wal segment, the racing commit\'s wal segment, and the abandoned first-attempt base must all be gone except the winning base');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd phase2/packages/sqlite-s3 && node --test test/checkpoint.test.js`
Expected: FAIL — `leaseStore` required but old `performCheckpoint` ignores it and never deletes/retries; the new race-repro and no-leak tests fail their assertions.

- [ ] **Step 3: Implement the new `performCheckpoint`**

Replace `src/checkpoint.js`:

```js
import { foldWalSegments, truncateToPageCount } from './merge.js';

export function createCheckpointPolicy({ maxWalBytes, maxIntervalMs, now = () => Date.now() }) {
  let bytesSinceCheckpoint = 0;
  let lastCheckpointAt = now();
  let dirty = false;

  return {
    recordSegment(byteLength) {
      bytesSinceCheckpoint += byteLength;
      dirty = true;
    },
    shouldCheckpoint() {
      if (bytesSinceCheckpoint >= maxWalBytes) return true;
      if (dirty && now() - lastCheckpointAt >= maxIntervalMs) return true;
      return false;
    },
    recordCheckpoint() {
      bytesSinceCheckpoint = 0;
      lastCheckpointAt = now();
      dirty = false;
    },
  };
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

export async function performCheckpoint({
  manifestStore,
  segmentStore,
  leaseStore,
  maxRetries = DEFAULT_MAX_RETRIES,
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  now = () => Date.now(),
  onBeforeWrite = async () => {},
}) {
  const { manifest: startManifest, etag: startEtag } = await manifestStore.read();
  if (!startManifest || !startManifest.walSegmentIds || startManifest.walSegmentIds.length === 0) {
    return { checkpointed: false };
  }

  let baseManifest = startManifest;
  let baseEtag = startEtag;
  let fileBytes = Buffer.alloc(0);
  let finalPageCount = 0;
  let foldedWalIds = [];

  if (baseManifest.baseSegmentId) {
    const base = await segmentStore.getSegment(baseManifest.baseSegmentId);
    fileBytes = Buffer.from(base.bytes);
    finalPageCount = baseManifest.pageSize > 0 ? Math.floor(fileBytes.length / baseManifest.pageSize) : 0;
  }

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const priorBaseSegmentId = baseManifest.baseSegmentId;
    const pending = baseManifest.walSegmentIds.filter((id) => !foldedWalIds.includes(id));

    ({ fileBytes, finalPageCount } = await foldWalSegments({
      fileBytes,
      finalPageCount,
      walSegmentIds: pending,
      segmentStore,
      pageSize: baseManifest.pageSize,
    }));
    foldedWalIds = [...foldedWalIds, ...pending];

    const mergedBytes = truncateToPageCount(fileBytes, finalPageCount, baseManifest.pageSize);
    const newBaseId = await segmentStore.putSegment(mergedBytes);
    const nextManifest = {
      baseSegmentId: newBaseId,
      walSegmentIds: [],
      pageSize: baseManifest.pageSize,
    };

    await onBeforeWrite({ attempt });

    try {
      await manifestStore.write(nextManifest, { expectedEtag: baseEtag });
      await reclaimSuperseded({
        leaseStore,
        segmentStore,
        candidateIds: [...(priorBaseSegmentId ? [priorBaseSegmentId] : []), ...foldedWalIds],
        now: now(),
      });
      return { checkpointed: true };
    } catch (err) {
      if (err.name !== 'ManifestConflictError') throw err;
      // This attempt lost the race -- its merged base must not leak.
      await segmentStore.deleteSegment(newBaseId);

      const latestManifest = err.current.manifest;
      if (latestManifest.baseSegmentId !== baseManifest.baseSegmentId) {
        // A DIFFERENT checkpoint won concurrently (not just a new commit) --
        // our merged bytes are built on a base that's no longer current.
        // Restart the merge from the new base rather than folding onto
        // stale bytes.
        fileBytes = Buffer.alloc(0);
        finalPageCount = 0;
        foldedWalIds = [];
        if (latestManifest.baseSegmentId) {
          const base = await segmentStore.getSegment(latestManifest.baseSegmentId);
          fileBytes = Buffer.from(base.bytes);
          finalPageCount = latestManifest.pageSize > 0
            ? Math.floor(fileBytes.length / latestManifest.pageSize)
            : 0;
        }
      }
      baseManifest = latestManifest;
      baseEtag = err.current.etag;
    }
  }

  return { checkpointed: false };
}

async function reclaimSuperseded({ leaseStore, segmentStore, candidateIds, now }) {
  if (candidateIds.length === 0) return;
  const protectedIds = await leaseStore.listActiveSegmentIds(now);
  const safeToDelete = candidateIds.filter((id) => !protectedIds.has(id));
  await Promise.all(safeToDelete.map((id) => segmentStore.deleteSegment(id)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd phase2/packages/sqlite-s3 && node --test test/checkpoint.test.js`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add phase2/packages/sqlite-s3/src/checkpoint.js phase2/packages/sqlite-s3/test/checkpoint.test.js
git commit -m "sqlite-s3: bounded-retry checkpoint with incremental fold and lease-gated reclamation"
```

---

### Task 7: Wire leases through `knex-client.js` and known config call sites

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/knex-client.js`
- Modify: `phase2/packages/sqlite-s3/src/index.js`
- Modify: `phase2/packages/sqlite-s3/test/knex-client.test.js`
- Modify: `phase2/packages/sqlite-s3/e2e/step_definitions/multi-writer-reconciliation.steps.js`

**Interfaces:**
- Consumes: `createLeaseStore` (Task 3), the updated `restoreLocalDb`/`performCheckpoint` signatures (Tasks 5 and 6).
- Produces: `s3` config objects (`{ manifestStore, segmentStore, checkpointPolicy, leaseStore }`) now include `leaseStore`, built from the same underlying object store as `manifestStore`/`segmentStore`. `index.js` also exports `createLeaseStore` and `performCheckpoint` (the latter was missing from the public surface entirely, and the backlog script in Task 8 needs it alongside `leaseStore`).

- [ ] **Step 1: Update `index.js` exports**

In `src/index.js`, add:

```js
export { createLeaseStore } from './leases.js';
export { createCheckpointPolicy, performCheckpoint } from './checkpoint.js';
```

Remove the now-duplicate line `export { createCheckpointPolicy } from './checkpoint.js';` (folded into the line above).

- [ ] **Step 2: Wire leases into `knex-client.js`**

In `acquireRawConnection()`, change:

```js
    await restoreLocalDb({
      manifest,
      segmentStore: this._s3.segmentStore,
      dbPath: this.connectionSettings.filename,
    });
```

to:

```js
    await restoreLocalDb({
      manifest,
      segmentStore: this._s3.segmentStore,
      leaseStore: this._s3.leaseStore,
      dbPath: this.connectionSettings.filename,
    });
```

In the fire-and-forget checkpoint kick-off, change:

```js
        performCheckpoint({ manifestStore: s3.manifestStore, segmentStore: s3.segmentStore })
```

to:

```js
        performCheckpoint({ manifestStore: s3.manifestStore, segmentStore: s3.segmentStore, leaseStore: s3.leaseStore })
```

- [ ] **Step 3: Update `test/knex-client.test.js`'s config construction**

Add the import:

```js
import { createLeaseStore } from '../src/leases.js';
```

In `makeS3Config(store)` (line 18), add `leaseStore: createLeaseStore(store),` alongside `manifestStore`/`segmentStore`/`checkpointPolicy`.

Two more tests build an `s3` config object by hand instead of via `makeS3Config`:

- The test starting around line 95 (`'data written via one Knex instance is visible after a simulated restart'`, or whichever test currently builds `manifestStore`/`segmentStore` from `store` and a hand-rolled `checkpointPolicy` around line 101): add `const leaseStore = createLeaseStore(store);` next to the `manifestStore`/`segmentStore` declarations, then add `leaseStore` to both `s3: { manifestStore, segmentStore, checkpointPolicy }` object literals (lines 109 and 150) in that test.
- The test starting around line 159 (`'a checkpoint failure does not break the caller\'s actual write'`): add `const leaseStore = createLeaseStore(store);` next to `realManifestStore`, then add `leaseStore,` inside the `s3: { manifestStore: realManifestStore, segmentStore, checkpointPolicy: {...} }` object literal (around line 182-190).

After these edits, every `SqliteS3Client` constructed in this file has a `leaseStore` in its `s3` config.

- [ ] **Step 4: Update the e2e step file's `s3Config` helper**

In `e2e/step_definitions/multi-writer-reconciliation.steps.js`, add the import:

```js
  createLeaseStore,
```

to the existing `from '../../src/index.js'` import block, and add `leaseStore: createLeaseStore(objectStore),` inside `world.sharedS3Config`.

- [ ] **Step 5: Run the full test suite**

Run: `cd phase2/packages/sqlite-s3 && npm test`
Expected: PASS — every test file, including `knex-client.test.js`.

- [ ] **Step 6: Commit**

```bash
git add phase2/packages/sqlite-s3/src/knex-client.js phase2/packages/sqlite-s3/src/index.js phase2/packages/sqlite-s3/test/knex-client.test.js phase2/packages/sqlite-s3/e2e/step_definitions/multi-writer-reconciliation.steps.js
git commit -m "sqlite-s3: wire reader leases through the knex client and known s3 config sites"
```

**Note for later:** any S3 config constructed outside this repo checkout (e.g. baked into a deploy image) must also add `leaseStore` when this change ships — this plan cannot locate or edit that file from here.

---

### Task 8: One-time (and repeatable) orphaned-segment reclamation

**Files:**
- Create: `phase2/packages/sqlite-s3/src/reclaim.js`
- Create: `phase2/packages/sqlite-s3/test/reclaim.test.js`
- Create: `phase2/packages/sqlite-s3/scripts/reclaim-orphaned-segments.js`

**Interfaces:**
- Consumes: `objectStore.list`/`delete` (Task 1), `segmentStore.deleteSegment` (Task 2), `leaseStore.listActiveSegmentIds` (Task 3), `manifestStore.read` (existing).
- Produces: `reclaimOrphanedSegments({ manifestStore, segmentStore, objectStore, leaseStore, now? })` → `Promise<{ scanned: number, deleted: string[] }>` — the library function, safe to call directly from an e2e/production script and safe to re-run repeatedly (it only ever deletes segments unreachable from the current manifest and unprotected by any live lease).

- [ ] **Step 1: Write the failing test**

Create `test/reclaim.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { createManifestStore } from '../src/manifest.js';
import { createLeaseStore } from '../src/leases.js';
import { reclaimOrphanedSegments } from '../src/reclaim.js';

test('reclaimOrphanedSegments deletes only segments unreachable from the manifest and unprotected by a lease', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);

  const reachableBaseId = await segmentStore.putSegment(Buffer.from('reachable-base'));
  const reachableWalId = await segmentStore.putSegment(Buffer.from('reachable-wal'));
  await manifestStore.write(
    { baseSegmentId: reachableBaseId, walSegmentIds: [reachableWalId], pageSize: 16 },
    { expectedEtag: null }
  );

  const orphanId = await segmentStore.putSegment(Buffer.from('orphan'));
  const leasedOrphanId = await segmentStore.putSegment(Buffer.from('leased-orphan'));
  await leaseStore.acquire({ baseSegmentId: leasedOrphanId, walSegmentIds: [] }, { ttlMs: 60_000 });
  const expiredLeaseOrphanId = await segmentStore.putSegment(Buffer.from('expired-lease-orphan'));
  await leaseStore.acquire({ baseSegmentId: expiredLeaseOrphanId, walSegmentIds: [] }, { ttlMs: 1, now: 0 });

  const objectStore = store;
  const result = await reclaimOrphanedSegments({ manifestStore, segmentStore, objectStore, leaseStore, now: 1000 });

  assert.deepEqual(result.deleted.sort(), [orphanId, expiredLeaseOrphanId].sort());
  assert.equal(result.scanned, 5);

  await segmentStore.getSegment(reachableBaseId);
  await segmentStore.getSegment(reachableWalId);
  await segmentStore.getSegment(leasedOrphanId);
  await assert.rejects(() => segmentStore.getSegment(orphanId), (err) => err.code === 'NotFound');
  await assert.rejects(() => segmentStore.getSegment(expiredLeaseOrphanId), (err) => err.code === 'NotFound');
});

test('reclaimOrphanedSegments is a no-op on a store with nothing to reclaim', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
  const baseSegmentId = await segmentStore.putSegment(Buffer.from('base'));
  await manifestStore.write({ baseSegmentId, walSegmentIds: [], pageSize: 16 }, { expectedEtag: null });

  const result = await reclaimOrphanedSegments({ manifestStore, segmentStore, objectStore: store, leaseStore });
  assert.deepEqual(result.deleted, []);
  assert.equal(result.scanned, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd phase2/packages/sqlite-s3 && node --test test/reclaim.test.js`
Expected: FAIL — cannot find module `../src/reclaim.js`.

- [ ] **Step 3: Implement `reclaim.js`**

Create `src/reclaim.js`:

```js
const SEGMENT_PREFIX = 'segments/';
const SEGMENT_SUFFIX = '.seg';

function segmentIdFromKey(key) {
  return key.slice(SEGMENT_PREFIX.length, key.length - SEGMENT_SUFFIX.length);
}

export async function reclaimOrphanedSegments({ manifestStore, segmentStore, objectStore, leaseStore, now = Date.now() }) {
  const { manifest } = await manifestStore.read();
  const reachable = new Set();
  if (manifest?.baseSegmentId) reachable.add(manifest.baseSegmentId);
  for (const id of manifest?.walSegmentIds ?? []) reachable.add(id);

  const protectedIds = await leaseStore.listActiveSegmentIds(now);
  const allKeys = await objectStore.list(SEGMENT_PREFIX);

  const deleted = [];
  for (const key of allKeys) {
    const id = segmentIdFromKey(key);
    if (reachable.has(id) || protectedIds.has(id)) continue;
    await segmentStore.deleteSegment(id);
    deleted.push(id);
  }

  return { scanned: allKeys.length, deleted };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd phase2/packages/sqlite-s3 && node --test test/reclaim.test.js`
Expected: PASS.

- [ ] **Step 5: Write the CLI script**

Create `scripts/reclaim-orphaned-segments.js`:

```js
#!/usr/bin/env node
import { createS3ObjectStore } from '../src/object-store.js';
import { createManifestStore } from '../src/manifest.js';
import { createSegmentStore } from '../src/segments.js';
import { createLeaseStore } from '../src/leases.js';
import { reclaimOrphanedSegments } from '../src/reclaim.js';

const SEGMENT_PREFIX = 'segments/';
const SEGMENT_SUFFIX = '.seg';

async function main() {
  const bucket = process.env.SQLITE_S3_BUCKET;
  if (!bucket) {
    console.error('SQLITE_S3_BUCKET env var is required.');
    process.exit(1);
  }
  const execute = process.argv.includes('--execute');

  const objectStore = createS3ObjectStore({ bucket });
  const manifestStore = createManifestStore(objectStore);
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);

  if (!execute) {
    const { manifest } = await manifestStore.read();
    const reachable = new Set(
      [manifest?.baseSegmentId, ...(manifest?.walSegmentIds ?? [])].filter(Boolean)
    );
    const protectedIds = await leaseStore.listActiveSegmentIds();
    const allKeys = await objectStore.list(SEGMENT_PREFIX);
    const orphaned = allKeys.filter((key) => {
      const id = key.slice(SEGMENT_PREFIX.length, key.length - SEGMENT_SUFFIX.length);
      return !reachable.has(id) && !protectedIds.has(id);
    });
    console.log(`Dry run against bucket "${bucket}": ${orphaned.length} of ${allKeys.length} segments would be deleted.`);
    console.log('Re-run with --execute to actually delete them.');
    return;
  }

  const { scanned, deleted } = await reclaimOrphanedSegments({ manifestStore, segmentStore, objectStore, leaseStore });
  console.log(`Scanned ${scanned} segments in bucket "${bucket}", deleted ${deleted.length} orphans.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

This defaults to a dry run (prints what it would delete without touching anything); `--execute` is required to actually delete. Hand this to the user to run against the production bucket rather than running it yourself.

- [ ] **Step 6: Run the full test suite one last time**

Run: `cd phase2/packages/sqlite-s3 && npm test`
Expected: PASS — every test file in the package.

- [ ] **Step 7: Commit**

```bash
git add phase2/packages/sqlite-s3/src/reclaim.js phase2/packages/sqlite-s3/test/reclaim.test.js phase2/packages/sqlite-s3/scripts/reclaim-orphaned-segments.js
git commit -m "sqlite-s3: add reusable + one-time orphaned-segment reclamation"
```
