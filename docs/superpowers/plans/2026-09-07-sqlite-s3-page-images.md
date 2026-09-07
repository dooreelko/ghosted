# Page-Image Segments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `phase2/packages/sqlite-s3`'s segment format (raw SQLite WAL bytes) with page-image segments (page number + page bytes), so segments from different writers compose correctly at restore — fixing the final review's C2 finding that raw WAL bytes from independent writers cannot be concatenated (SQLite's WAL frame checksums chain to that WAL file's own header salts, so splicing two writers' WAL segments together corrupts recovery at the seam).

**Architecture:** Segments now hold `[{pageNumber, bytes}]` instead of raw WAL bytes, extracted from a commit's (already-trimmed-to-last-commit-boundary) WAL frames, deduped to last-write-wins per page. Restore no longer writes any `-wal` file or relies on SQLite's WAL recovery at all — it builds the `.db` file directly by overlaying page images onto the base snapshot at their byte offsets (`(pageNumber - 1) × pageSize`), then truncates to the final page count. Page size, which used to be read from the WAL file's own header, is now carried explicitly in the manifest (set once, on the first-ever commit).

**Tech Stack:** Same as the existing package — Node.js (ESM), `better-sqlite3`, `knex`, `msgpackr`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-07-sqlite-s3-design.md` (see the "Revision" note under Context, and the updated Storage model / Commit path / Startup sections)

## Global Constraints

- No new external dependencies — `msgpackr` is already a package dependency.
- Existing public interfaces that other code depends on (`createSegmentStore`, `createManifestStore`, `createCheckpointPolicy`, `restoreLocalDb`, `SqliteS3Client`, `registerS3Config`) keep the same names and shapes; only `commitWalDelta`'s signature gains one parameter (`pageSize`), and `restore.js`'s internals change without changing `restoreLocalDb`'s own signature.
- All 35 existing tests must keep passing unmodified in *intent* — some (restore.test.js's three tests, commit.test.js's four call sites) need mechanical updates to match the new segment format, but no test's asserted *behavior* should change.
- Never assume single-writer — this plan exists specifically to make multi-writer restore actually correct, matching the project's explicit "don't assume single writer" requirement.

---

## File Structure

```
phase2/packages/sqlite-s3/
  src/
    page-images.js       # NEW — extractPageImages, encodePageImages, decodePageImages
    commit.js             # MODIFIED — commitWalDelta gains a pageSize param, threads it into the manifest
    restore.js              # REWRITTEN — page-table reconstruction instead of WAL-file writing
    knex-client.js            # MODIFIED — _maybeCaptureCommit builds page images; acquireRawConnection simplified
    wal.js                      # UNCHANGED — already exports everything page-images.js needs (FRAME_HEADER_SIZE_BYTES, parseFrames, parseWalHeader)
  test/
    page-images.test.js  # NEW
    commit.test.js         # MODIFIED — call sites pass pageSize; meta assertions extended
    restore.test.js          # REWRITTEN — constructs page-image segments instead of raw WAL bytes
    knex-client.test.js        # UNCHANGED — all four existing tests interact only through the public Knex/SQL API, so they're already encoding-agnostic; adding one new test
```

`page-images.js` sits between `wal.js` (pure frame parsing) and everything that stores/restores segments — it owns exactly one responsibility: turning trimmed WAL frames into the page-image segment payload, and back.

---

### Task 1: page-images.js — extract, encode, decode

**Files:**
- Create: `phase2/packages/sqlite-s3/src/page-images.js`
- Test: `phase2/packages/sqlite-s3/test/page-images.test.js`

**Interfaces:**
- Consumes: `FRAME_HEADER_SIZE_BYTES` from `./wal.js` (already exported).
- Produces: `extractPageImages(buf: Buffer, frames: Array<{pageNumber, offset, length}>, pageSize: number) -> Array<{pageNumber: number, bytes: Buffer}>` (deduped to last occurrence per page number, order otherwise irrelevant to callers); `encodePageImages(pages: Array<{pageNumber, bytes}>) -> Buffer`; `decodePageImages(buf: Buffer) -> Array<{pageNumber, bytes}>` (inverse of encode).

- [ ] **Step 1: Write the failing test**

```js
// phase2/packages/sqlite-s3/test/page-images.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPageImages, encodePageImages, decodePageImages } from '../src/page-images.js';

const PAGE_SIZE = 16;
const FRAME_HEADER_SIZE = 24;

function buildFrame({ pageNumber, pageByte, pageSize = PAGE_SIZE }) {
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header.writeUInt32BE(pageNumber, 0);
  const page = Buffer.alloc(pageSize, pageByte);
  return Buffer.concat([header, page]);
}

test('extractPageImages pulls page bytes out at the correct offset', () => {
  const frame = buildFrame({ pageNumber: 3, pageByte: 0xaa });
  const frames = [{ pageNumber: 3, offset: 0, length: frame.length }];
  const pages = extractPageImages(frame, frames, PAGE_SIZE);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].pageNumber, 3);
  assert.equal(pages[0].bytes.length, PAGE_SIZE);
  assert.ok(pages[0].bytes.every((b) => b === 0xaa));
});

test('extractPageImages dedupes to the last occurrence of a repeated page number', () => {
  const frameA = buildFrame({ pageNumber: 5, pageByte: 0x01 });
  const frameB = buildFrame({ pageNumber: 5, pageByte: 0x02 });
  const buf = Buffer.concat([frameA, frameB]);
  const frames = [
    { pageNumber: 5, offset: 0, length: frameA.length },
    { pageNumber: 5, offset: frameA.length, length: frameB.length },
  ];
  const pages = extractPageImages(buf, frames, PAGE_SIZE);
  assert.equal(pages.length, 1);
  assert.ok(pages[0].bytes.every((b) => b === 0x02), 'must keep the LAST write to page 5, not the first');
});

test('extractPageImages preserves distinct page numbers independently', () => {
  const frameA = buildFrame({ pageNumber: 1, pageByte: 0x10 });
  const frameB = buildFrame({ pageNumber: 2, pageByte: 0x20 });
  const buf = Buffer.concat([frameA, frameB]);
  const frames = [
    { pageNumber: 1, offset: 0, length: frameA.length },
    { pageNumber: 2, offset: frameA.length, length: frameB.length },
  ];
  const pages = extractPageImages(buf, frames, PAGE_SIZE);
  assert.equal(pages.length, 2);
  const byPage = Object.fromEntries(pages.map((p) => [p.pageNumber, p.bytes]));
  assert.ok(byPage[1].every((b) => b === 0x10));
  assert.ok(byPage[2].every((b) => b === 0x20));
});

test('encodePageImages then decodePageImages round-trips page number and bytes exactly', () => {
  const pages = [
    { pageNumber: 1, bytes: Buffer.from([1, 2, 3]) },
    { pageNumber: 7, bytes: Buffer.from([9, 9, 9, 9]) },
  ];
  const encoded = encodePageImages(pages);
  assert.ok(Buffer.isBuffer(encoded));
  const decoded = decodePageImages(encoded);
  assert.deepEqual(decoded, pages);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/page-images.test.js
```

Expected: FAIL — `src/page-images.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// phase2/packages/sqlite-s3/src/page-images.js
import { FRAME_HEADER_SIZE_BYTES } from './wal.js';
import { pack, unpack } from 'msgpackr';

export function extractPageImages(buf, frames, pageSize) {
  const pages = new Map();
  for (const frame of frames) {
    const start = frame.offset + FRAME_HEADER_SIZE_BYTES;
    const bytes = Buffer.from(buf.subarray(start, start + pageSize));
    pages.set(frame.pageNumber, bytes);
  }
  return [...pages.entries()].map(([pageNumber, bytes]) => ({ pageNumber, bytes }));
}

export function encodePageImages(pages) {
  return pack(pages);
}

export function decodePageImages(buf) {
  return unpack(buf);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd phase2/packages/sqlite-s3 && node --test test/page-images.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/page-images.js test/page-images.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: add page-image extraction and segment encoding

Turns trimmed WAL frames into page-image segments (page number + page
bytes, deduped last-write-wins), the storage unit that lets segments
from independent writers compose at restore — unlike raw WAL bytes,
whose checksum chains are keyed to one specific WAL file's own header
salts and cannot be spliced across writers (final review finding C2).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

### Task 2: commit.js — thread pageSize into the manifest, record dbSizeAfterCommit in segment meta

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/commit.js`
- Modify: `phase2/packages/sqlite-s3/test/commit.test.js`

**Interfaces:**
- Consumes: nothing new — still uses `writeSetFromFrames` from `./wal.js`.
- Produces: `createCommitter(...).commitWalDelta(payloadBytes: Buffer, frames: Array<{pageNumber, dbSizeAfterCommit}>, pageSize: number) -> {segmentId, etag} | {retryTransaction: true}` — the manifest this writes now also carries `pageSize` (set on first-ever commit, carried forward unchanged thereafter), and each segment's `meta` now also carries `dbSizeAfterCommit` (the last frame's value) alongside the existing `writeSet`. Restore (Task 3) reads both.

Restore needs to know the on-disk page size (to compute `(pageNumber - 1) × pageSize` byte offsets) and, after replaying each segment, the total page count as of that segment's commit (to truncate the final file correctly, e.g. after a `VACUUM` shrinks it) — both of which only ever change at commit time, so this is the natural place to record them.

- [ ] **Step 1: Update commit.test.js's call sites and write the new assertions**

Every existing `commitWalDelta(bytes, frames)` call needs a third argument. Pick `4096` (a real, common SQLite page size) as the test pageSize throughout — its exact value doesn't matter to these tests, only that it round-trips.

```js
// phase2/packages/sqlite-s3/test/commit.test.js — replace the whole file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { createManifestStore } from '../src/manifest.js';
import { createCommitter } from '../src/commit.js';

const PAGE_SIZE = 4096;

function setup() {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const committer = createCommitter({ manifestStore, segmentStore, sleep: async () => {} });
  return { segmentStore, manifestStore, committer };
}

test('first commit ever writes a manifest with baseSegmentId null and records pageSize', async () => {
  const { committer, manifestStore } = setup();
  const frames = [{ pageNumber: 1, dbSizeAfterCommit: 1 }];
  const result = await committer.commitWalDelta(Buffer.from('delta-1'), frames, PAGE_SIZE);
  assert.ok(result.segmentId);
  const { manifest } = await manifestStore.read();
  assert.equal(manifest.baseSegmentId, null);
  assert.deepEqual(manifest.walSegmentIds, [result.segmentId]);
  assert.equal(manifest.pageSize, PAGE_SIZE);
});

test('pageSize is carried forward unchanged on later commits', async () => {
  const { committer, manifestStore } = setup();
  await committer.commitWalDelta(Buffer.from('a'), [{ pageNumber: 1, dbSizeAfterCommit: 1 }], PAGE_SIZE);
  await committer.commitWalDelta(Buffer.from('b'), [{ pageNumber: 2, dbSizeAfterCommit: 2 }], PAGE_SIZE);
  const { manifest } = await manifestStore.read();
  assert.equal(manifest.pageSize, PAGE_SIZE);
});

test('segment meta records dbSizeAfterCommit from the last frame', async () => {
  const { committer, manifestStore, segmentStore } = setup();
  const frames = [
    { pageNumber: 1, dbSizeAfterCommit: 0 },
    { pageNumber: 2, dbSizeAfterCommit: 7 },
  ];
  const result = await committer.commitWalDelta(Buffer.from('delta'), frames, PAGE_SIZE);
  const seg = await segmentStore.getSegment(result.segmentId);
  assert.equal(seg.meta.dbSizeAfterCommit, 7);
  assert.deepEqual(seg.meta.writeSet, [1, 2]);
});

test('two non-overlapping commits both land (second rebases automatically)', async () => {
  const { committer, manifestStore } = setup();
  // Writer A reads manifest version 0, then commits touching page 1.
  const resultA = await committer.commitWalDelta(Buffer.from('a'), [{ pageNumber: 1, dbSizeAfterCommit: 1 }], PAGE_SIZE);
  // Writer B, unaware of A, also started from version 0 and commits touching page 2.
  // Simulate this by calling commitWalDelta again without B having "seen" A's write —
  // commitWalDelta always re-reads the manifest internally, so this models B racing in
  // right after A landed: B's local transaction was built against the pre-A base, but
  // since B's write-set (page 2) doesn't overlap A's (page 1), it must still land.
  const resultB = await committer.commitWalDelta(Buffer.from('b'), [{ pageNumber: 2, dbSizeAfterCommit: 2 }], PAGE_SIZE);
  assert.ok(resultB.segmentId);
  const { manifest } = await manifestStore.read();
  assert.deepEqual(manifest.walSegmentIds, [resultA.segmentId, resultB.segmentId]);
});

test('overlapping commit is reported as a required retry, not silently merged', async () => {
  const { committer, manifestStore, segmentStore } = setup();
  await committer.commitWalDelta(Buffer.from('a'), [{ pageNumber: 5, dbSizeAfterCommit: 5 }], PAGE_SIZE);
  // Force a stale read: manually give the committer an outdated manifest snapshot by
  // racing a manifest write in between read and write via a wrapped manifestStore.
  const staleManifestStore = {
    async read() {
      // Return the pre-A state even though the store already has A's commit —
      // this simulates writer B having snapshotted before A landed.
      return { manifest: { baseSegmentId: null, walSegmentIds: [], pageSize: PAGE_SIZE }, etag: null };
    },
    write: manifestStore.write.bind(manifestStore),
  };
  const staleCommitter = createCommitter({
    manifestStore: staleManifestStore,
    segmentStore,
    sleep: async () => {},
  });
  const result = await staleCommitter.commitWalDelta(Buffer.from('b'), [{ pageNumber: 5, dbSizeAfterCommit: 5 }], PAGE_SIZE);
  assert.deepEqual(result, { retryTransaction: true });
});

test('gives up after 10 attempts if every retry keeps conflicting', async () => {
  const { manifestStore, segmentStore } = setup();
  await manifestStore.write({ baseSegmentId: null, walSegmentIds: [], pageSize: PAGE_SIZE }, { expectedEtag: null });
  const alwaysStaleStore = {
    read: async () => ({ manifest: { baseSegmentId: null, walSegmentIds: [], pageSize: PAGE_SIZE }, etag: null }),
    write: async () => {
      // Every write conflicts because someone else always beats us with an overlapping page.
      const seg = await segmentStore.putSegment(Buffer.from('other'), { writeSet: [99], dbSizeAfterCommit: 99 });
      await manifestStore.write(
        {
          baseSegmentId: null,
          walSegmentIds: [...(await manifestStore.read()).manifest.walSegmentIds, seg],
          pageSize: PAGE_SIZE,
        },
        { expectedEtag: (await manifestStore.read()).etag }
      );
      const err = new Error('manifest changed since last read');
      err.name = 'ManifestConflictError';
      err.current = await manifestStore.read();
      throw err;
    },
  };
  const flakyCommitter = createCommitter({ manifestStore: alwaysStaleStore, segmentStore, sleep: async () => {} });
  await assert.rejects(
    () => flakyCommitter.commitWalDelta(Buffer.from('mine'), [{ pageNumber: 5, dbSizeAfterCommit: 5 }], PAGE_SIZE),
    /max retries/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/commit.test.js
```

Expected: FAIL — `manifest.pageSize`/`seg.meta.dbSizeAfterCommit` are `undefined` against the current implementation.

- [ ] **Step 3: Update the implementation**

```js
// phase2/packages/sqlite-s3/src/commit.js
import { writeSetFromFrames } from './wal.js';

const MAX_ATTEMPTS = 10;

function fullJitterDelay(attempt, baseMs = 50, capMs = 2000) {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.random() * exp;
}

export function createCommitter({ manifestStore, segmentStore, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  return {
    async commitWalDelta(payloadBytes, frames, pageSize) {
      const writeSet = writeSetFromFrames(frames);
      const dbSizeAfterCommit = frames[frames.length - 1]?.dbSizeAfterCommit ?? 0;
      let { manifest, etag } = await manifestStore.read();

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const segmentId = await segmentStore.putSegment(payloadBytes, { writeSet, dbSizeAfterCommit });
        const nextManifest = {
          baseSegmentId: manifest ? manifest.baseSegmentId : null,
          walSegmentIds: manifest ? [...manifest.walSegmentIds, segmentId] : [segmentId],
          pageSize: manifest ? manifest.pageSize : pageSize,
        };
        try {
          const result = await manifestStore.write(nextManifest, { expectedEtag: etag });
          return { segmentId, etag: result.etag };
        } catch (err) {
          if (err.name !== 'ManifestConflictError') throw err;

          const priorWalIds = manifest ? manifest.walSegmentIds : [];
          const latestManifest = err.current.manifest;
          const newSegmentIds = latestManifest.walSegmentIds.slice(priorWalIds.length);
          const theirWriteSets = await Promise.all(
            newSegmentIds.map(async (id) => (await segmentStore.getSegment(id)).meta.writeSet ?? [])
          );
          const theirPages = new Set(theirWriteSets.flat());
          const overlap = writeSet.some((page) => theirPages.has(page));

          manifest = latestManifest;
          etag = err.current.etag;

          if (overlap) {
            return { retryTransaction: true };
          }
          await sleep(fullJitterDelay(attempt));
        }
      }
      throw new Error('commit failed after max retries: conflicting writers');
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd phase2/packages/sqlite-s3 && node --test test/commit.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/commit.js test/commit.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: thread pageSize and dbSizeAfterCommit through commit path

pageSize (needed to compute page byte offsets at restore) is now set
once in the manifest on the first-ever commit and carried forward
unchanged. Each segment's meta now also records dbSizeAfterCommit (the
authoritative page count as of that commit), which restore uses to
truncate the reconstructed file correctly. Part of the C2 fix
(page-image segments) — commit.js's own retry/conflict logic is
unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

### Task 3: restore.js — direct page-table reconstruction

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/restore.js` (full rewrite of its body; signature unchanged)
- Modify: `phase2/packages/sqlite-s3/test/restore.test.js` (full rewrite)

**Interfaces:**
- Consumes: `decodePageImages` from `./page-images.js` (Task 1); segments now expected to hold page-image payloads (from Task 2's `commitWalDelta`) and a `meta.dbSizeAfterCommit` field; manifests now carry a `pageSize` field.
- Produces: `restoreLocalDb({manifest, segmentStore, dbPath}) -> Promise<void>` — same signature as before. No longer writes any `-wal` file; writes only `dbPath` itself as an already-consistent SQLite database file.

This task is where the actual C2 fix lands: segments are now applied by overlaying page images at their byte offsets rather than by concatenating raw WAL bytes and relying on SQLite's own (writer-specific) WAL recovery.

- [ ] **Step 1: Write the failing test**

These tests build page-image segments the same way the real commit path will (Task 4 wires this up for real; here we construct them directly to test `restoreLocalDb` in isolation). The key new test — `restoreLocalDb composes segments from two independent writers` — is the one that would have caught C2: it captures WAL frames from two *separately created* `better-sqlite3` databases (so their WAL files have different, independently-random header salts, exactly the scenario raw-WAL-byte segments couldn't survive) and confirms both writers' changes appear in the restored file.

```js
// phase2/packages/sqlite-s3/test/restore.test.js — replace the whole file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { restoreLocalDb } from '../src/restore.js';
import { parseWalHeader, parseFrames } from '../src/wal.js';
import { extractPageImages, encodePageImages } from '../src/page-images.js';

async function tmpPath(name) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sqlite-s3-test-'));
  return path.join(dir, name);
}

// Mirrors exactly what the real commit path (Task 4) does: parse the WAL
// delta's frames, extract page images, encode them as the segment payload.
async function walFileToPageImageSegment(walPath) {
  const buf = await readFile(walPath);
  const { pageSize } = parseWalHeader(buf);
  const frames = parseFrames(buf, pageSize, 32);
  const pages = extractPageImages(buf, frames, pageSize);
  const dbSizeAfterCommit = frames[frames.length - 1]?.dbSizeAfterCommit ?? 0;
  return { payload: encodePageImages(pages), pageSize, dbSizeAfterCommit };
}

test('restoreLocalDb with a null manifest leaves no files (fresh db)', async () => {
  const dbPath = await tmpPath('fresh.db');
  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  await restoreLocalDb({ manifest: null, segmentStore, dbPath });
  await assert.rejects(() => stat(dbPath));
});

test('restoreLocalDb rebuilds a real, openable database from a base segment plus a wal segment', async () => {
  const sourcePath = await tmpPath('source.db');
  const db = new Database(sourcePath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
  const baseBytes = await readFile(sourcePath);
  const { payload, pageSize, dbSizeAfterCommit } = await walFileToPageImageSegment(`${sourcePath}-wal`);
  db.close();

  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const baseSegmentId = await segmentStore.putSegment(baseBytes);
  const walSegmentId = await segmentStore.putSegment(payload, { dbSizeAfterCommit });
  const manifest = { baseSegmentId, walSegmentIds: [walSegmentId], pageSize };

  const restoredPath = await tmpPath('restored.db');
  await restoreLocalDb({ manifest, segmentStore, dbPath: restoredPath });

  const restored = new Database(restoredPath);
  const row = restored.prepare('SELECT v FROM t WHERE id = 1').get();
  assert.equal(row.v, 'hello');
  restored.close();
});

test('restoreLocalDb rebuilds a real, openable database from wal segments alone (no base segment yet)', async () => {
  const sourcePath = await tmpPath('source-nobase.db');
  const db = new Database(sourcePath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
  const { payload, pageSize, dbSizeAfterCommit } = await walFileToPageImageSegment(`${sourcePath}-wal`);
  db.close();

  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const walSegmentId = await segmentStore.putSegment(payload, { dbSizeAfterCommit });
  const manifest = { baseSegmentId: null, walSegmentIds: [walSegmentId], pageSize };

  const restoredPath = await tmpPath('restored-nobase.db');
  await restoreLocalDb({ manifest, segmentStore, dbPath: restoredPath });

  const restored = new Database(restoredPath);
  const row = restored.prepare('SELECT v FROM t WHERE id = 1').get();
  assert.equal(row.v, 'hello');
  restored.close();
});

test('restoreLocalDb composes segments from two independent writers (C2 regression)', async () => {
  // Writer A: creates the base database and one row.
  const basePath = await tmpPath('writerA-base.db');
  const dbA = new Database(basePath);
  dbA.pragma('journal_mode = WAL');
  dbA.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  dbA.prepare('INSERT INTO t (v) VALUES (?)').run('from A');
  const baseBytes = await readFile(basePath);
  const segA = await walFileToPageImageSegment(`${basePath}-wal`);
  dbA.close();

  // Writer B: an INDEPENDENTLY created local database (its own WAL file has
  // its own random header salts, unrelated to writer A's) that restored from
  // the same base and added a second row. Simulate this by restoring the
  // base into a fresh file, then writing through it.
  const writerBPath = await tmpPath('writerB.db');
  await writeFile(writerBPath, baseBytes);
  const dbB = new Database(writerBPath);
  dbB.pragma('journal_mode = WAL');
  dbB.prepare('INSERT INTO t (v) VALUES (?)').run('from B');
  const segB = await walFileToPageImageSegment(`${writerBPath}-wal`);
  dbB.close();

  // Both writers' segments land in one shared manifest, in commit order.
  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const baseSegmentId = await segmentStore.putSegment(baseBytes);
  const segAId = await segmentStore.putSegment(segA.payload, { dbSizeAfterCommit: segA.dbSizeAfterCommit });
  const segBId = await segmentStore.putSegment(segB.payload, { dbSizeAfterCommit: segB.dbSizeAfterCommit });
  const manifest = {
    baseSegmentId,
    walSegmentIds: [segAId, segBId],
    pageSize: segA.pageSize,
  };

  const restoredPath = await tmpPath('restored-multiwriter.db');
  await restoreLocalDb({ manifest, segmentStore, dbPath: restoredPath });

  const restored = new Database(restoredPath);
  const rows = restored.prepare('SELECT v FROM t ORDER BY id').all();
  // Both writers' rows must be present — this is exactly what raw WAL-byte
  // segments could not guarantee (writer B's segment would corrupt recovery
  // at the point it was spliced onto writer A's WAL, per final-review C2).
  assert.deepEqual(rows.map((r) => r.v).sort(), ['from A', 'from B']);
  restored.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/restore.test.js
```

Expected: FAIL — the current `restore.js` writes a `-wal` file, doesn't understand `pageSize`/page-image segments, and the multi-writer test would fail against the OLD implementation even if the test helpers were adapted (that's the point — this is the regression test for C2).

- [ ] **Step 3: Write the implementation**

```js
// phase2/packages/sqlite-s3/src/restore.js
import { rm, writeFile } from 'node:fs/promises';
import { decodePageImages } from './page-images.js';

export async function restoreLocalDb({ manifest, segmentStore, dbPath }) {
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });

  const hasWalSegments = manifest && manifest.walSegmentIds && manifest.walSegmentIds.length > 0;
  if (!manifest || (!manifest.baseSegmentId && !hasWalSegments)) {
    return; // truly nothing to restore — a fresh database
  }

  let fileBytes = Buffer.alloc(0);
  if (manifest.baseSegmentId) {
    const base = await segmentStore.getSegment(manifest.baseSegmentId);
    fileBytes = Buffer.from(base.bytes);
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
      finalPageCount = seg.meta.dbSizeAfterCommit;
    }
  }

  if (finalPageCount > 0) {
    fileBytes = fileBytes.subarray(0, finalPageCount * pageSize);
  }

  await writeFile(dbPath, fileBytes);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd phase2/packages/sqlite-s3 && node --test test/restore.test.js
```

Expected: PASS, 4 tests — including the two-independent-writers composition test.

- [ ] **Step 5: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/restore.js test/restore.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: rebuild restore as direct page-table reconstruction (fixes C2)

Restore no longer writes a -wal file or relies on SQLite's WAL
recovery at all: it overlays each segment's page images onto the base
snapshot at their byte offsets, then truncates to the final page count
(from the last segment's dbSizeAfterCommit). This is what actually
fixes the final review's C2 finding — page images from independent
writers compose by simple overlay, with no per-writer WAL checksum
chain to break. Verified with a new test that captures WAL frames from
two genuinely separate better-sqlite3 databases (independently random
header salts) and confirms both writers' rows survive restore.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

### Task 4: knex-client.js — ship page images instead of raw WAL bytes; simplify acquireRawConnection

**Files:**
- Modify: `phase2/packages/sqlite-s3/src/knex-client.js`
- Modify: `phase2/packages/sqlite-s3/test/knex-client.test.js` (one new test added; the four existing tests are unchanged since they only interact through the public Knex/SQL API)

**Interfaces:**
- Consumes: `extractPageImages`, `encodePageImages` from `./page-images.js` (Task 1); `commitWalDelta`'s new `pageSize` parameter (Task 2); `restoreLocalDb` no longer produces a `-wal` file (Task 3).
- Produces: `SqliteS3Client` — same public shape as before.

Because `restoreLocalDb` no longer ever writes a `-wal` file, the C1-fix machinery in `acquireRawConnection` (deriving `_lastWalOffset`/`_pageSize` from a restored WAL file) is no longer needed — there is never a restored WAL to account for, so both always start fresh at `0`/`null` again, exactly as the client did before C1 was ever found. This is a simplification, not a regression: C1's own regression test (`data survives two successive simulated restarts`) still exercises the same scenario and must still pass, it just no longer needs special-casing to do so, because restore itself no longer has the byte-duplication hazard C1 was about.

- [ ] **Step 1: Write the failing test**

Add this test to the end of `test/knex-client.test.js` (leave the four existing tests untouched):

```js
// Append to phase2/packages/sqlite-s3/test/knex-client.test.js

// Regression test for C2: segments committed by two SEPARATE Knex/SqliteS3Client
// instances (simulating two real concurrent writer processes, each with its own
// local file and its own independently-random WAL header salts) must both survive
// being restored by a third instance. This is the scenario raw-WAL-byte segments
// could not support — writer B's segment would corrupt recovery at the seam where
// it was spliced onto writer A's WAL history.
test('data committed by two independent writer instances both survive a later restore (C2)', async () => {
  const store = createInMemoryObjectStore();

  const dbPathA = await tmpDbPath();
  const knexA = makeKnex(dbPathA, makeS3Config(store));
  await knexA.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
  });
  await knexA('posts').insert({ title: 'from writer A' });
  await knexA.destroy();

  // Writer B: a SEPARATE instance that restores from the same S3 state (so it
  // picks up writer A's table) and then writes its own row — a genuinely
  // independent local file with its own WAL lineage, not a continuation of A's.
  const dbPathB = await tmpDbPath();
  const knexB = makeKnex(dbPathB, makeS3Config(store));
  await knexB('posts').insert({ title: 'from writer B' });
  await knexB.destroy();

  // A third instance restoring from the shared S3 state must see both rows.
  const dbPathC = await tmpDbPath();
  const knexC = makeKnex(dbPathC, makeS3Config(store));
  const rows = await knexC('posts').select('title').orderBy('id');
  assert.deepEqual(
    rows.map((r) => r.title),
    ['from writer A', 'from writer B']
  );
  await knexC.destroy();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js
```

Expected: FAIL — the current implementation still ships raw WAL bytes, so this test fails the same way the old `restore.js` would have (this is the client-level version of Task 3's regression test).

- [ ] **Step 3: Update the implementation**

```js
// phase2/packages/sqlite-s3/src/knex-client.js
// Verified against knex@3.3.0 — adjust this import if it stops resolving.
import BetterSQLite3Client from 'knex/lib/dialects/better-sqlite3/index.js';
import { statSync, readSync, openSync, closeSync } from 'node:fs';
import { restoreLocalDb } from './restore.js';
import { createCommitter } from './commit.js';
import { parseWalHeader, parseFrames } from './wal.js';
import { extractPageImages, encodePageImages } from './page-images.js';

// Some hosts (observed with Ghost + knex-migrator) construct additional Knex
// clients from an independently re-derived copy of the connection config
// (e.g. Ghost's MigratorConfig.js snapshots `config.get('database')` at
// require-time for knex-migrator's own use). Passing this._s3 through that
// path is unreliable — a plain object nested with function-valued stores can
// fail to survive whatever cloning/merging produced that independent copy,
// even though a top-level class reference (`client: SqliteS3Client`) does.
// A process-wide registration point sidesteps that entirely: every
// SqliteS3Client instance in this process shares one S3 wiring, set once via
// `registerS3Config()` before Ghost/Knex boot, regardless of how many
// separately-constructed client instances end up existing.
const registry = { s3: undefined };

export function registerS3Config(s3Config) {
  registry.s3 = s3Config;
}

export class SqliteS3Client extends BetterSQLite3Client {
  constructor(config) {
    // This package's commit-capture logic assumes exactly one physical
    // connection is ever open at a time: acquireRawConnection() below
    // unconditionally deletes and rewrites the local .db/-wal/-shm files on
    // every acquire. Knex's default pool (min 2, max 10 for most dialects)
    // would let a second pooled connection acquire concurrently and delete
    // the database out from under the first connection's in-progress work.
    // Pin the pool to exactly one connection regardless of what's passed in
    // `config.pool` — this must happen before `super(config)`, since the
    // base Client constructor copies `config.pool` into `this.config.pool`
    // and synchronously initializes the pool from it.
    super({ ...config, pool: { min: 1, max: 1 } });
    this._s3 = config.connection.s3 ?? registry.s3;
    this._lastWalOffset = 0;
    this._pageSize = null;
  }

  async acquireRawConnection() {
    const { manifest } = await this._s3.manifestStore.read();
    this._manifest = manifest;
    await restoreLocalDb({
      manifest,
      segmentStore: this._s3.segmentStore,
      dbPath: this.connectionSettings.filename,
    });
    // restoreLocalDb (page-image reconstruction) never produces a `-wal`
    // file — it writes an already-consistent `.db` file directly. So there
    // is never a restored WAL to account for: capture progress always
    // starts fresh, exactly as it does for a brand-new database.
    this._lastWalOffset = 0;
    this._pageSize = null;
    const connection = await super.acquireRawConnection();
    // Commit capture reads deltas out of the `-wal` file, so the connection
    // must run in WAL journal mode (better-sqlite3 defaults to rollback-journal
    // mode, which never produces a `-wal` file at all).
    connection.pragma('journal_mode = WAL');
    // Commit capture tracks progress through the `-wal` file by byte offset.
    // SQLite's automatic checkpointing (default ~1000 pages) can truncate or
    // reset that file on its own, silently invalidating the offset with no
    // error surfaced. Disable it — checkpoint-triggering is already out of
    // scope for this client, so letting the WAL grow unboundedly for the
    // life of one connection is an already-accepted limitation, not a new
    // problem introduced by turning this off.
    connection.pragma('wal_autocheckpoint = 0');
    return connection;
  }

  async _query(connection, obj) {
    const result = await super._query(connection, obj);
    if (connection.inTransaction === false) {
      await this._maybeCaptureCommit(connection);
    }
    return result;
  }

  async _maybeCaptureCommit() {
    // Some Knex-internal code paths invoke this method with `this` bound to
    // an object that shares SqliteS3Client's prototype (so method lookup
    // resolves) but was never run through `new SqliteS3Client(...)` — e.g. a
    // lightweight clone Knex derives internally for pooling/transactions,
    // observed in practice from knex-migrator's own connection handling. Such
    // an object has none of this class's constructor-set instance state.
    // The S3 wiring is process-wide by nature (one Ghost process, one S3
    // bucket), so read it from the module-level registry directly rather
    // than trusting `this._s3` — that's robust regardless of what `this` is.
    const s3 = this._s3 ?? registry.s3;
    const walPath = `${this.connectionSettings.filename}-wal`;
    let size;
    try {
      size = statSync(walPath).size;
    } catch {
      return; // no WAL file yet (e.g. a read-only autocommit statement before any write)
    }
    // Some Knex-internal code paths (observed via knex-migrator's own connection
    // handling) construct client-like objects that never ran through our
    // constructor, leaving this undefined rather than the constructor's 0.
    // Treat a missing offset as "nothing captured yet" rather than propagating
    // undefined into arithmetic (undefined - number = NaN => Buffer.alloc(NaN)).
    const lastWalOffset = this._lastWalOffset ?? 0;
    if (size <= lastWalOffset) return;

    const delta = Buffer.alloc(size - lastWalOffset);
    const fd = openSync(walPath, 'r');
    readSync(fd, delta, 0, delta.length, lastWalOffset);
    closeSync(fd);

    const isFirstCapture = lastWalOffset === 0;
    const pageSize = isFirstCapture ? parseWalHeader(delta).pageSize : this._pageSize;
    const allFrames = parseFrames(delta, pageSize, isFirstCapture ? 32 : 0);

    // `connection.inTransaction === false` is also true immediately after a
    // ROLLBACK, and any frames a rolled-back transaction spilled into the
    // WAL file before rolling back remain physically present in it. SQLite
    // sets `dbSizeAfterCommit` to nonzero only on the last frame of an
    // actually-committed transaction, so use that to find the last real
    // commit boundary within this delta and discard anything after it
    // (orphaned rolled-back frames, or — shouldn't happen given the
    // `inTransaction` guard, but handled defensively anyway — a
    // still-in-progress transaction caught mid-write). Bytes after the trim
    // point are simply not considered captured yet: they're re-examined
    // (and re-trimmed, or included if a later real commit extends past
    // them) on the next capture attempt.
    let lastCommitFrameIndex = -1;
    for (let i = allFrames.length - 1; i >= 0; i -= 1) {
      if (allFrames[i].dbSizeAfterCommit !== 0) {
        lastCommitFrameIndex = i;
        break;
      }
    }
    if (lastCommitFrameIndex === -1) {
      // No committed-transaction boundary in this delta yet — nothing to ship.
      return;
    }
    const lastCommitFrame = allFrames[lastCommitFrameIndex];
    const trimEnd = lastCommitFrame.offset + lastCommitFrame.length;
    const frames = allFrames.slice(0, lastCommitFrameIndex + 1);

    // Extract page images from the trimmed frames (deduped last-write-wins
    // per page) and encode them as this segment's payload — see
    // docs/superpowers/specs/2026-09-07-sqlite-s3-design.md's Revision note
    // for why this replaced shipping raw WAL bytes (final review finding C2:
    // WAL checksum chains can't be spliced across independent writers).
    const pages = extractPageImages(delta, frames, pageSize);
    const payload = encodePageImages(pages);

    const committer = createCommitter({
      manifestStore: s3.manifestStore,
      segmentStore: s3.segmentStore,
    });
    const outcome = await committer.commitWalDelta(payload, frames, pageSize);

    if (outcome.retryTransaction) {
      // By this point the write has already committed locally — there is no
      // local transaction left to "retry". A caller retry would duplicate
      // data. This writer's local state has now diverged from the shared
      // history; do NOT advance _lastWalOffset, so the next successful
      // capture naturally re-includes these bytes (plus whatever
      // accumulates after) in one larger delta/segment.
      throw new Error(
        "sqlite-s3: local write committed but lost an optimistic-concurrency race shipping to S3 — this writer's local state has now diverged from the shared history (see docs/superpowers/specs/2026-09-07-sqlite-s3-design.md's accepted risks; full reconciliation is a follow-up)"
      );
    }

    // Only advance past these bytes once they're confirmed durably shipped.
    // Advance by the trimmed amount, not the full delta — any bytes after
    // the last commit boundary (e.g. a rolled-back transaction's orphaned
    // frames) are not yet considered captured.
    this._pageSize = pageSize;
    this._lastWalOffset = lastWalOffset + trimEnd;
    s3.checkpointPolicy.recordSegment(payload.length);
  }
}
```

- [ ] **Step 4: Run the new test, then the full suite**

```bash
cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js
```

Expected: PASS, 5 tests (4 existing + the new C2 regression test).

```bash
cd phase2/packages/sqlite-s3 && npm test
```

Expected: PASS, all tests across every file (Tasks 1-4 plus every pre-existing test).

- [ ] **Step 5: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/knex-client.js test/knex-client.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: ship page-image segments from commit capture (fixes C2)

_maybeCaptureCommit now extracts page images from the trimmed WAL
frames and ships those (via commit.js's now-pageSize-aware
commitWalDelta) instead of raw WAL bytes. acquireRawConnection's
restored-WAL-offset special-casing (added for C1) is removed, since
restoreLocalDb (page-table reconstruction, Task 3) never produces a
-wal file anymore — there's nothing to account for, so capture always
starts fresh at 0, same as a brand-new database. Verified with a new
test simulating two independent writer instances (separate local
files, separate WAL lineages) whose commits both survive being
restored by a third instance.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** page-image segment format (Task 1), manifest carrying `pageSize` + segment `meta.dbSizeAfterCommit` (Task 2), direct page-table restore with no WAL/recovery dependency (Task 3), commit-capture shipping page images (Task 4) — every part of the spec's revised Storage model / Commit path / Startup sections maps to a task. The multi-writer composability claim is directly tested twice (Task 3's `restore.test.js` at the storage-function level, Task 4's `knex-client.test.js` at the full-client level) — this is deliberate: it's the exact property C2 found missing, so it gets a belt-and-suspenders regression test.
- **Placeholder scan:** no TBD/TODO; every step has real code.
- **Type/name consistency:** `extractPageImages(buf, frames, pageSize)`, `encodePageImages(pages)`, `decodePageImages(buf)` are used identically in Tasks 1, 3, and 4. `commitWalDelta(payloadBytes, frames, pageSize)`'s new third parameter is threaded consistently from Task 2 through Task 4's call site. `manifest.pageSize` and `segment.meta.dbSizeAfterCommit` are produced in Task 2 and consumed in Task 3 with matching names throughout.
- **Not in scope for this plan** (unchanged from the existing spec's "Known limitations," not reopened here): checkpointing still isn't wired to run; there's still no reconciliation when a commit loses a conflict race; the per-statement-round-trip throughput limitation is unaffected by this change (page images are typically smaller than raw WAL frames including their headers/checksums, so if anything this plan's segments are slightly cheaper to ship, but that's incidental, not a fix for the throughput finding).
