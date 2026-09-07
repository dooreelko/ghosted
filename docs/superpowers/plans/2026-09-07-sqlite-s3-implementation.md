# SQLite-over-S3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Knex client package that makes SQLite durable against S3 (WAL-frame segments + CAS manifest), so Ghost can run on Lightsail Containers with no persistent disk, surviving restarts and supporting multiple concurrent writers without downtime.

**Architecture:** Reuse SQLite's own WAL as the append-only segment log instead of building a parallel one. Each committed transaction's WAL bytes become an immutable S3 object; a single JSON manifest object (updated via S3 conditional writes) points at the ordered list of segments plus the current base snapshot. A Knex client wrapping `better-sqlite3` restores local files from S3 on connect and ships new WAL bytes to S3 after every commit, using WAL frame page numbers as the write-set for optimistic conflict detection.

**Tech Stack:** Node.js (>=20, ESM), `better-sqlite3`, `knex`, `@aws-sdk/client-s3`, `msgpackr`. Tests via Node's built-in `node:test` + `node:assert/strict` — no test framework dependency.

**Spec:** `docs/superpowers/specs/2026-09-07-sqlite-s3-design.md`

## Global Constraints

- Package lives at `phase2/packages/sqlite-s3/`.
- Manifest CAS uses native S3 conditional writes (`If-Match`/`If-None-Match`), never DynamoDB.
- Segments are msgpack-encoded; the manifest is plain JSON.
- Multi-writer correctness is required — never assume single writer.
- Conflict retry: up to 10 attempts, full-jitter backoff (matches the python original this ports from).
- Checkpoint trigger: size OR time, but a time-triggered checkpoint is a no-op if nothing changed since the last one.
- No Ghost core changes — Ghost must still see a Knex client that behaves like `sqlite3`/`better-sqlite3` from its own config's perspective.
- Smoke test targets a real, throwaway S3 bucket created via `aws cli`, not OpenTofu.

---

## File Structure

```
phase2/packages/sqlite-s3/
  package.json
  src/
    wal.js               # pure WAL header/frame parsing, no I/O
    object-store.js       # narrow ObjectStore port + real S3 adapter + in-memory fake
    segments.js            # segment put/get on top of ObjectStore, msgpack encode/decode
    manifest.js             # manifest read/CAS-write on top of ObjectStore
    commit.js                # commit orchestration: write-set diff, retry/backoff
    checkpoint.js             # checkpoint trigger policy
    restore.js                # rebuild local db+wal files from manifest+segments
    knex-client.js             # Knex client: wires restore on connect, commit capture per query
    index.js                    # public exports
  test/
    wal.test.js
    object-store.test.js
    segments.test.js
    manifest.test.js
    commit.test.js
    checkpoint.test.js
    restore.test.js
    knex-client.test.js
  smoke/
    create-bucket.sh
    docker-compose.smoke.yaml
    run-smoke-test.sh
```

Each `src/` file has one responsibility and depends only on the files above it in this list (e.g. `commit.js` depends on `wal.js`, `segments.js`, `manifest.js`; nothing depends on `knex-client.js`). This keeps every file testable in isolation without real AWS or real SQLite except where the file's whole job is talking to one of those.

---

### Task 1: WAL frame parser

**Files:**
- Create: `phase2/packages/sqlite-s3/package.json`
- Create: `phase2/packages/sqlite-s3/src/wal.js`
- Test: `phase2/packages/sqlite-s3/test/wal.test.js`

**Interfaces:**
- Produces: `parseWalHeader(buf: Buffer) -> { magic, formatVersion, pageSize, checkpointSeq, salt1, salt2 }`; `parseFrames(buf: Buffer, pageSize: number, startOffset?: number) -> Array<{ pageNumber, dbSizeAfterCommit, offset, length }>`; `writeSetFromFrames(frames) -> number[]` (sorted, deduped page numbers).

- [ ] **Step 1: Scaffold the package**

```bash
mkdir -p phase2/packages/sqlite-s3/src phase2/packages/sqlite-s3/test phase2/packages/sqlite-s3/smoke
```

Write `phase2/packages/sqlite-s3/package.json`:

```json
{
  "name": "@ghost-phase2/sqlite-s3",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.700.0",
    "better-sqlite3": "^11.7.0",
    "knex": "^3.1.0",
    "msgpackr": "^1.11.2"
  }
}
```

- [ ] **Step 2: Write the failing test**

WAL frame format (from SQLite's file format spec): 32-byte file header, then repeating 24-byte frame headers each followed by `pageSize` bytes of page data. All multi-byte fields are big-endian. Frame header layout: page number (u32 @0), DB size in pages after commit — nonzero only on the last frame of a transaction (u32 @4), salt-1/salt-2 (u32 @8/@12), checksum-1/checksum-2 (u32 @16/@20).

```js
// phase2/packages/sqlite-s3/test/wal.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWalHeader, parseFrames, writeSetFromFrames } from '../src/wal.js';

const PAGE_SIZE = 16;

function buildWalHeader({ pageSize = PAGE_SIZE } = {}) {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(0x377f0682, 0);
  buf.writeUInt32BE(3007000, 4);
  buf.writeUInt32BE(pageSize, 8);
  buf.writeUInt32BE(0, 12);
  buf.writeUInt32BE(111, 16);
  buf.writeUInt32BE(222, 20);
  buf.writeUInt32BE(0, 24);
  buf.writeUInt32BE(0, 28);
  return buf;
}

function buildFrame({ pageNumber, dbSizeAfterCommit = 0, pageSize = PAGE_SIZE }) {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(pageNumber, 0);
  header.writeUInt32BE(dbSizeAfterCommit, 4);
  const page = Buffer.alloc(pageSize, 0xab);
  return Buffer.concat([header, page]);
}

test('parseWalHeader reads magic and page size', () => {
  const header = buildWalHeader();
  const parsed = parseWalHeader(header);
  assert.equal(parsed.magic, 0x377f0682);
  assert.equal(parsed.pageSize, PAGE_SIZE);
  assert.equal(parsed.salt1, 111);
  assert.equal(parsed.salt2, 222);
});

test('parseWalHeader rejects a buffer with bad magic', () => {
  const bad = buildWalHeader();
  bad.writeUInt32BE(0xdeadbeef, 0);
  assert.throws(() => parseWalHeader(bad), /Not a WAL file/);
});

test('parseFrames walks a full wal file (header + two frames, one commit)', () => {
  const header = buildWalHeader();
  const f1 = buildFrame({ pageNumber: 3 });
  const f2 = buildFrame({ pageNumber: 7, dbSizeAfterCommit: 9 });
  const buf = Buffer.concat([header, f1, f2]);
  const frames = parseFrames(buf, PAGE_SIZE);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].pageNumber, 3);
  assert.equal(frames[0].dbSizeAfterCommit, 0);
  assert.equal(frames[1].pageNumber, 7);
  assert.equal(frames[1].dbSizeAfterCommit, 9);
});

test('parseFrames with a non-default startOffset (no header in this delta)', () => {
  const f1 = buildFrame({ pageNumber: 5, dbSizeAfterCommit: 5 });
  const frames = parseFrames(f1, PAGE_SIZE, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].pageNumber, 5);
});

test('writeSetFromFrames dedupes and sorts page numbers', () => {
  const frames = [{ pageNumber: 9 }, { pageNumber: 3 }, { pageNumber: 9 }];
  assert.deepEqual(writeSetFromFrames(frames), [3, 9]);
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && npm install --package-lock-only=false --no-audit --no-fund && node --test test/wal.test.js
```

Expected: FAIL — `src/wal.js` does not exist yet (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 4: Write the implementation**

```js
// phase2/packages/sqlite-s3/src/wal.js
const WAL_HEADER_SIZE = 32;
const FRAME_HEADER_SIZE = 24;
const WAL_MAGIC_BIG_ENDIAN_CKSUM = 0x377f0682;
const WAL_MAGIC_LITTLE_ENDIAN_CKSUM = 0x377f0683;

export function parseWalHeader(buf) {
  if (buf.length < WAL_HEADER_SIZE) {
    throw new Error('WAL header truncated');
  }
  const magic = buf.readUInt32BE(0);
  if (magic !== WAL_MAGIC_BIG_ENDIAN_CKSUM && magic !== WAL_MAGIC_LITTLE_ENDIAN_CKSUM) {
    throw new Error(`Not a WAL file (bad magic 0x${magic.toString(16)})`);
  }
  return {
    magic,
    formatVersion: buf.readUInt32BE(4),
    pageSize: buf.readUInt32BE(8),
    checkpointSeq: buf.readUInt32BE(12),
    salt1: buf.readUInt32BE(16),
    salt2: buf.readUInt32BE(20),
  };
}

export function parseFrames(buf, pageSize, startOffset = WAL_HEADER_SIZE) {
  const frameSize = FRAME_HEADER_SIZE + pageSize;
  const frames = [];
  let offset = startOffset;
  while (offset + frameSize <= buf.length) {
    const pageNumber = buf.readUInt32BE(offset);
    const dbSizeAfterCommit = buf.readUInt32BE(offset + 4);
    frames.push({ pageNumber, dbSizeAfterCommit, offset, length: frameSize });
    offset += frameSize;
  }
  return frames;
}

export function writeSetFromFrames(frames) {
  return [...new Set(frames.map((f) => f.pageNumber))].sort((a, b) => a - b);
}

export const WAL_HEADER_SIZE_BYTES = WAL_HEADER_SIZE;
export const FRAME_HEADER_SIZE_BYTES = FRAME_HEADER_SIZE;
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd phase2/packages/sqlite-s3 && node --test test/wal.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add package.json src/wal.js test/wal.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: add WAL frame parser

Pure parsing of SQLite's WAL file header and frame headers, and
write-set extraction from frame page numbers. No I/O — foundation for
segment capture and conflict detection.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

### Task 2: Object store port (S3 adapter + in-memory fake)

**Files:**
- Create: `phase2/packages/sqlite-s3/src/object-store.js`
- Test: `phase2/packages/sqlite-s3/test/object-store.test.js`

**Interfaces:**
- Produces: `createInMemoryObjectStore() -> ObjectStore`; `createS3ObjectStore({ bucket, client }) -> ObjectStore`, where `ObjectStore = { put(key: string, bytes: Buffer, opts?: { ifNoneMatch?: boolean, ifMatch?: string }) -> Promise<{ etag: string }>, get(key: string) -> Promise<{ bytes: Buffer, etag: string }> }`. `get` on a missing key rejects with an error whose `.code === 'NotFound'`. `put` with a failed precondition rejects with an error whose `.code === 'PreconditionFailed'`.
- Consumes: nothing from earlier tasks.

The in-memory fake is what every other unit test in this plan uses — only the smoke test (Task 9) touches the real S3 adapter.

- [ ] **Step 1: Write the failing test**

```js
// phase2/packages/sqlite-s3/test/object-store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';

test('put then get round-trips bytes and returns a stable etag', async () => {
  const store = createInMemoryObjectStore();
  const { etag } = await store.put('k', Buffer.from('hello'));
  const got = await store.get('k');
  assert.equal(got.bytes.toString(), 'hello');
  assert.equal(got.etag, etag);
});

test('get on a missing key rejects with code NotFound', async () => {
  const store = createInMemoryObjectStore();
  await assert.rejects(() => store.get('missing'), (err) => err.code === 'NotFound');
});

test('ifNoneMatch:true rejects with PreconditionFailed if the key already exists', async () => {
  const store = createInMemoryObjectStore();
  await store.put('k', Buffer.from('a'));
  await assert.rejects(
    () => store.put('k', Buffer.from('b'), { ifNoneMatch: true }),
    (err) => err.code === 'PreconditionFailed'
  );
});

test('ifMatch rejects with PreconditionFailed if the etag is stale', async () => {
  const store = createInMemoryObjectStore();
  await store.put('k', Buffer.from('a'));
  await assert.rejects(
    () => store.put('k', Buffer.from('b'), { ifMatch: 'not-the-real-etag' }),
    (err) => err.code === 'PreconditionFailed'
  );
});

test('ifMatch succeeds when the etag matches, and updates the etag', async () => {
  const store = createInMemoryObjectStore();
  const first = await store.put('k', Buffer.from('a'));
  const second = await store.put('k', Buffer.from('b'), { ifMatch: first.etag });
  const got = await store.get('k');
  assert.equal(got.bytes.toString(), 'b');
  assert.equal(got.etag, second.etag);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/object-store.test.js
```

Expected: FAIL — `src/object-store.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// phase2/packages/sqlite-s3/src/object-store.js
import { createHash, randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createInMemoryObjectStore() {
  const objects = new Map(); // key -> { bytes, etag }
  return {
    async get(key) {
      const obj = objects.get(key);
      if (!obj) throw makeError('NotFound', `no object at ${key}`);
      return { bytes: obj.bytes, etag: obj.etag };
    },
    async put(key, bytes, opts = {}) {
      const existing = objects.get(key);
      if (opts.ifNoneMatch && existing) {
        throw makeError('PreconditionFailed', `${key} already exists`);
      }
      if (opts.ifMatch !== undefined && opts.ifMatch !== null) {
        if (!existing || existing.etag !== opts.ifMatch) {
          throw makeError('PreconditionFailed', `${key} etag mismatch`);
        }
      }
      const etag = randomUUID();
      objects.set(key, { bytes: Buffer.from(bytes), etag });
      return { etag };
    },
  };
}

export function createS3ObjectStore({ bucket, client = new S3Client({}) }) {
  return {
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = [];
        for await (const chunk of res.Body) chunks.push(chunk);
        return { bytes: Buffer.concat(chunks), etag: res.ETag };
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
          throw makeError('NotFound', `no object at ${key}`);
        }
        throw err;
      }
    },
    async put(key, bytes, opts = {}) {
      const input = { Bucket: bucket, Key: key, Body: bytes };
      if (opts.ifNoneMatch) input.IfNoneMatch = '*';
      if (opts.ifMatch !== undefined && opts.ifMatch !== null) input.IfMatch = opts.ifMatch;
      try {
        const res = await client.send(new PutObjectCommand(input));
        return { etag: res.ETag };
      } catch (err) {
        if (err.$metadata?.httpStatusCode === 412) {
          throw makeError('PreconditionFailed', `${key} precondition failed`);
        }
        throw err;
      }
    },
  };
}
```

`createHash` is imported but unused in this minimal version — remove the import if the linter complains; it's left as a hook in case a content-hash-based key scheme replaces `randomUUID` later (segments.js in Task 3 uses `randomUUID` for segment ids, not this file).

- [ ] **Step 4: Run test to verify it passes**

```bash
cd phase2/packages/sqlite-s3 && node --test test/object-store.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/object-store.js test/object-store.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: add ObjectStore port with S3 adapter and in-memory fake

Narrow interface (get/put with If-Match/If-None-Match semantics) so
every later unit test can run against the in-memory fake instead of
real S3; only the smoke test touches the real adapter.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

**Note:** the unused `createHash` import must actually be removed before committing (dead import) — run `node --check src/object-store.js` and remove it; the snippet above keeps it only for step-by-step narration.

---

### Task 3: Segment store

**Files:**
- Create: `phase2/packages/sqlite-s3/src/segments.js`
- Test: `phase2/packages/sqlite-s3/test/segments.test.js`

**Interfaces:**
- Consumes: `ObjectStore` from Task 2 (`store.put`, `store.get`).
- Produces: `createSegmentStore(store: ObjectStore) -> { putSegment(bytes: Buffer, meta?: object) -> Promise<string>, getSegment(id: string) -> Promise<{ meta: object, bytes: Buffer }> }`.

- [ ] **Step 1: Write the failing test**

```js
// phase2/packages/sqlite-s3/test/segments.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';

test('putSegment then getSegment round-trips bytes and metadata', async () => {
  const store = createSegmentStore(createInMemoryObjectStore());
  const id = await store.putSegment(Buffer.from('wal-bytes'), { writeSet: [1, 2, 3] });
  const seg = await store.getSegment(id);
  assert.equal(seg.bytes.toString(), 'wal-bytes');
  assert.deepEqual(seg.meta.writeSet, [1, 2, 3]);
});

test('putSegment ids are unique across calls', async () => {
  const store = createSegmentStore(createInMemoryObjectStore());
  const a = await store.putSegment(Buffer.from('a'));
  const b = await store.putSegment(Buffer.from('b'));
  assert.notEqual(a, b);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/segments.test.js
```

Expected: FAIL — `src/segments.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// phase2/packages/sqlite-s3/src/segments.js
import { randomUUID } from 'node:crypto';
import { pack, unpack } from 'msgpackr';

export function createSegmentStore(store) {
  return {
    async putSegment(bytes, meta = {}) {
      const id = randomUUID();
      const encoded = pack({ meta, bytes });
      await store.put(`segments/${id}.seg`, encoded, { ifNoneMatch: true });
      return id;
    },
    async getSegment(id) {
      const { bytes: encoded } = await store.get(`segments/${id}.seg`);
      const { meta, bytes } = unpack(encoded);
      return { meta, bytes };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd phase2/packages/sqlite-s3 && node --test test/segments.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/segments.js test/segments.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: add msgpack-encoded segment store

Wraps ObjectStore to give segments (base snapshots and WAL deltas)
random ids and msgpack-encoded {meta, bytes} envelopes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

### Task 4: Manifest store with CAS

**Files:**
- Create: `phase2/packages/sqlite-s3/src/manifest.js`
- Test: `phase2/packages/sqlite-s3/test/manifest.test.js`

**Interfaces:**
- Consumes: `ObjectStore` from Task 2.
- Produces: `ManifestConflictError` (has `.name === 'ManifestConflictError'` and `.current: { manifest, etag }`); `createManifestStore(store: ObjectStore) -> { read() -> Promise<{ manifest: {baseSegmentId, walSegmentIds} | null, etag: string | null }>, write(manifest, { expectedEtag }) -> Promise<{ etag: string }> }` — `write` throws `ManifestConflictError` on a stale `expectedEtag`.

- [ ] **Step 1: Write the failing test**

```js
// phase2/packages/sqlite-s3/test/manifest.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createManifestStore, ManifestConflictError } from '../src/manifest.js';

test('read on an empty store returns null manifest and null etag', async () => {
  const m = createManifestStore(createInMemoryObjectStore());
  const { manifest, etag } = await m.read();
  assert.equal(manifest, null);
  assert.equal(etag, null);
});

test('first write with expectedEtag: null succeeds', async () => {
  const m = createManifestStore(createInMemoryObjectStore());
  const { etag } = await m.write({ baseSegmentId: null, walSegmentIds: ['a'] }, { expectedEtag: null });
  assert.ok(etag);
  const read = await m.read();
  assert.deepEqual(read.manifest, { baseSegmentId: null, walSegmentIds: ['a'] });
});

test('write with a stale expectedEtag throws ManifestConflictError carrying the current state', async () => {
  const m = createManifestStore(createInMemoryObjectStore());
  const first = await m.write({ baseSegmentId: null, walSegmentIds: ['a'] }, { expectedEtag: null });
  await assert.rejects(
    () => m.write({ baseSegmentId: null, walSegmentIds: ['a', 'stale-write'] }, { expectedEtag: 'not-real' }),
    (err) => {
      assert.ok(err instanceof ManifestConflictError);
      assert.deepEqual(err.current.manifest.walSegmentIds, ['a']);
      assert.equal(err.current.etag, first.etag);
      return true;
    }
  );
});

test('write with the correct expectedEtag succeeds and advances the etag', async () => {
  const m = createManifestStore(createInMemoryObjectStore());
  const first = await m.write({ baseSegmentId: null, walSegmentIds: ['a'] }, { expectedEtag: null });
  const second = await m.write({ baseSegmentId: null, walSegmentIds: ['a', 'b'] }, { expectedEtag: first.etag });
  assert.notEqual(second.etag, first.etag);
  const read = await m.read();
  assert.deepEqual(read.manifest.walSegmentIds, ['a', 'b']);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/manifest.test.js
```

Expected: FAIL — `src/manifest.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// phase2/packages/sqlite-s3/src/manifest.js
const MANIFEST_KEY = 'root.json';

export class ManifestConflictError extends Error {
  constructor(current) {
    super('manifest changed since last read');
    this.name = 'ManifestConflictError';
    this.current = current;
  }
}

export function createManifestStore(store) {
  async function read() {
    try {
      const { bytes, etag } = await store.get(MANIFEST_KEY);
      return { manifest: JSON.parse(bytes.toString('utf8')), etag };
    } catch (err) {
      if (err.code === 'NotFound') {
        return { manifest: null, etag: null };
      }
      throw err;
    }
  }

  return {
    read,
    async write(manifest, { expectedEtag }) {
      const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
      try {
        const { etag } = await store.put(MANIFEST_KEY, bytes, {
          ifMatch: expectedEtag ?? undefined,
          ifNoneMatch: expectedEtag === null,
        });
        return { etag };
      } catch (err) {
        if (err.code === 'PreconditionFailed') {
          const current = await read();
          throw new ManifestConflictError(current);
        }
        throw err;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd phase2/packages/sqlite-s3 && node --test test/manifest.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/manifest.js test/manifest.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: add manifest store with S3-conditional-write CAS

root.json is the single mutable pointer; every write is conditioned on
the caller's last-read etag and surfaces a ManifestConflictError
(carrying the current state) on a stale write.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

### Task 5: Commit orchestrator (optimistic conflict detection + retry)

**Files:**
- Create: `phase2/packages/sqlite-s3/src/commit.js`
- Test: `phase2/packages/sqlite-s3/test/commit.test.js`

**Interfaces:**
- Consumes: `writeSetFromFrames` from `wal.js`; `SegmentStore` from `segments.js`; `ManifestStore` + `ManifestConflictError` from `manifest.js`.
- Produces: `createCommitter({ manifestStore, segmentStore, sleep? }) -> { commitWalDelta(walBytes: Buffer, frames) -> Promise<{ segmentId: string, etag: string } | { retryTransaction: true }> }`.

This is the core of the multi-writer design: two writers racing to commit non-overlapping pages both succeed (one rebases); two writers racing on the same page cause the loser to report `retryTransaction: true` so the caller re-runs its SQL transaction against the new base.

- [ ] **Step 1: Write the failing test**

```js
// phase2/packages/sqlite-s3/test/commit.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { createManifestStore } from '../src/manifest.js';
import { createCommitter } from '../src/commit.js';

function setup() {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const committer = createCommitter({ manifestStore, segmentStore, sleep: async () => {} });
  return { segmentStore, manifestStore, committer };
}

test('first commit ever writes a manifest with baseSegmentId null', async () => {
  const { committer, manifestStore } = setup();
  const frames = [{ pageNumber: 1 }];
  const result = await committer.commitWalDelta(Buffer.from('delta-1'), frames);
  assert.ok(result.segmentId);
  const { manifest } = await manifestStore.read();
  assert.equal(manifest.baseSegmentId, null);
  assert.deepEqual(manifest.walSegmentIds, [result.segmentId]);
});

test('two non-overlapping commits both land (second rebases automatically)', async () => {
  const { committer, manifestStore } = setup();
  // Writer A reads manifest version 0, then commits touching page 1.
  const resultA = await committer.commitWalDelta(Buffer.from('a'), [{ pageNumber: 1 }]);
  // Writer B, unaware of A, also started from version 0 and commits touching page 2.
  // Simulate this by calling commitWalDelta again without B having "seen" A's write —
  // commitWalDelta always re-reads the manifest internally, so this models B racing in
  // right after A landed: B's local transaction was built against the pre-A base, but
  // since B's write-set (page 2) doesn't overlap A's (page 1), it must still land.
  const resultB = await committer.commitWalDelta(Buffer.from('b'), [{ pageNumber: 2 }]);
  assert.ok(resultB.segmentId);
  const { manifest } = await manifestStore.read();
  assert.deepEqual(manifest.walSegmentIds, [resultA.segmentId, resultB.segmentId]);
});

test('overlapping commit is reported as a required retry, not silently merged', async () => {
  const { committer, manifestStore, segmentStore } = setup();
  await committer.commitWalDelta(Buffer.from('a'), [{ pageNumber: 5 }]);
  // Force a stale read: manually give the committer an outdated manifest snapshot by
  // racing a manifest write in between read and write via a wrapped manifestStore.
  const staleManifestStore = {
    async read() {
      // Return the pre-A state even though the store already has A's commit —
      // this simulates writer B having snapshotted before A landed.
      return { manifest: { baseSegmentId: null, walSegmentIds: [] }, etag: null };
    },
    write: manifestStore.write.bind(manifestStore),
  };
  const staleCommitter = createCommitter({
    manifestStore: staleManifestStore,
    segmentStore,
    sleep: async () => {},
  });
  const result = await staleCommitter.commitWalDelta(Buffer.from('b'), [{ pageNumber: 5 }]);
  assert.deepEqual(result, { retryTransaction: true });
});

test('gives up after 10 attempts if every retry keeps conflicting', async () => {
  const { manifestStore, segmentStore } = setup();
  await manifestStore.write({ baseSegmentId: null, walSegmentIds: [] }, { expectedEtag: null });
  const alwaysStaleStore = {
    read: async () => ({ manifest: { baseSegmentId: null, walSegmentIds: [] }, etag: null }),
    write: async () => {
      // Every write conflicts because someone else always beats us with an overlapping page.
      const seg = await segmentStore.putSegment(Buffer.from('other'), { writeSet: [5] });
      await manifestStore.write(
        { baseSegmentId: null, walSegmentIds: [...(await manifestStore.read()).manifest.walSegmentIds, seg] },
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
    () => flakyCommitter.commitWalDelta(Buffer.from('mine'), [{ pageNumber: 5 }]),
    /max retries/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/commit.test.js
```

Expected: FAIL — `src/commit.js` does not exist.

- [ ] **Step 3: Write the implementation**

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
    async commitWalDelta(walBytes, frames) {
      const writeSet = writeSetFromFrames(frames);
      let { manifest, etag } = await manifestStore.read();

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const segmentId = await segmentStore.putSegment(walBytes, { writeSet });
        const nextManifest = {
          baseSegmentId: manifest ? manifest.baseSegmentId : null,
          walSegmentIds: manifest ? [...manifest.walSegmentIds, segmentId] : [segmentId],
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

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/commit.js test/commit.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: add commit orchestrator with optimistic conflict detection

Ships a WAL delta as a segment and CAS-appends it to the manifest.
On conflict, diffs write-sets (WAL frame page numbers) against the
segments that landed first: no overlap rebases and retries (full-jitter
backoff, <=10 attempts), overlap reports retryTransaction so the caller
re-runs its SQL against the new base.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

### Task 6: Checkpoint policy

**Files:**
- Create: `phase2/packages/sqlite-s3/src/checkpoint.js`
- Test: `phase2/packages/sqlite-s3/test/checkpoint.test.js`

**Interfaces:**
- Produces: `createCheckpointPolicy({ maxWalBytes: number, maxIntervalMs: number, now?: () => number }) -> { recordSegment(byteLength: number) -> void, shouldCheckpoint() -> boolean, recordCheckpoint() -> void }`.

- [ ] **Step 1: Write the failing test**

```js
// phase2/packages/sqlite-s3/test/checkpoint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpointPolicy } from '../src/checkpoint.js';

test('no checkpoint needed with no activity', () => {
  const policy = createCheckpointPolicy({ maxWalBytes: 1000, maxIntervalMs: 60_000 });
  assert.equal(policy.shouldCheckpoint(), false);
});

test('size-triggered: checkpoint once accumulated bytes cross the threshold', () => {
  const policy = createCheckpointPolicy({ maxWalBytes: 100, maxIntervalMs: 60_000 });
  policy.recordSegment(60);
  assert.equal(policy.shouldCheckpoint(), false);
  policy.recordSegment(50);
  assert.equal(policy.shouldCheckpoint(), true);
});

test('recordCheckpoint resets the size counter', () => {
  const policy = createCheckpointPolicy({ maxWalBytes: 100, maxIntervalMs: 60_000 });
  policy.recordSegment(150);
  assert.equal(policy.shouldCheckpoint(), true);
  policy.recordCheckpoint();
  assert.equal(policy.shouldCheckpoint(), false);
});

test('time-triggered: checkpoint after the interval, but only if something changed', () => {
  let clock = 0;
  const policy = createCheckpointPolicy({ maxWalBytes: 1_000_000, maxIntervalMs: 1000, now: () => clock });
  clock = 2000;
  assert.equal(policy.shouldCheckpoint(), false, 'idle period must not trigger a no-op checkpoint');
  policy.recordSegment(1);
  assert.equal(policy.shouldCheckpoint(), true);
});

test('time-triggered checkpoint is not re-armed until the interval passes again', () => {
  let clock = 0;
  const policy = createCheckpointPolicy({ maxWalBytes: 1_000_000, maxIntervalMs: 1000, now: () => clock });
  policy.recordSegment(1);
  clock = 1500;
  assert.equal(policy.shouldCheckpoint(), true);
  policy.recordCheckpoint();
  policy.recordSegment(1);
  clock = 1600;
  assert.equal(policy.shouldCheckpoint(), false);
  clock = 2600;
  assert.equal(policy.shouldCheckpoint(), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/checkpoint.test.js
```

Expected: FAIL — `src/checkpoint.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// phase2/packages/sqlite-s3/src/checkpoint.js
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd phase2/packages/sqlite-s3 && node --test test/checkpoint.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/checkpoint.js test/checkpoint.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: add checkpoint trigger policy

Size-OR-time triggered, with the time trigger a no-op during idle
periods (only fires if a segment landed since the last checkpoint).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

### Task 7: Local restore from manifest + segments

**Files:**
- Create: `phase2/packages/sqlite-s3/src/restore.js`
- Test: `phase2/packages/sqlite-s3/test/restore.test.js`

**Interfaces:**
- Consumes: `SegmentStore` from Task 3; a manifest shape `{ baseSegmentId, walSegmentIds }` from Task 4.
- Produces: `restoreLocalDb({ manifest, segmentStore, dbPath }) -> Promise<void>` — writes `dbPath` and `${dbPath}-wal` (or leaves both absent for a fresh DB).

This test uses real `better-sqlite3` to generate genuine WAL bytes (open a DB, write, capture real WAL frames) rather than hand-crafted buffers — round-tripping through actual SQLite is the only way to be confident the reconstructed files are byte-valid.

- [ ] **Step 1: Add the `better-sqlite3` dev/runtime dependency and write the failing test**

```bash
cd phase2/packages/sqlite-s3 && npm install
```

```js
// phase2/packages/sqlite-s3/test/restore.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { restoreLocalDb } from '../src/restore.js';

async function tmpPath(name) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sqlite-s3-test-'));
  return path.join(dir, name);
}

test('restoreLocalDb with a null manifest leaves no files (fresh db)', async () => {
  const dbPath = await tmpPath('fresh.db');
  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  await restoreLocalDb({ manifest: null, segmentStore, dbPath });
  await assert.rejects(() => stat(dbPath));
});

test('restoreLocalDb rebuilds a real, openable database from a base segment plus wal segments', async () => {
  // Produce genuine WAL bytes using real SQLite.
  const sourcePath = await tmpPath('source.db');
  const db = new Database(sourcePath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');

  const walBytes = await readFile(`${sourcePath}-wal`);
  const baseBytes = await readFile(sourcePath);
  db.close();

  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const baseSegmentId = await segmentStore.putSegment(baseBytes);
  const walSegmentId = await segmentStore.putSegment(walBytes);
  const manifest = { baseSegmentId, walSegmentIds: [walSegmentId] };

  const restoredPath = await tmpPath('restored.db');
  await restoreLocalDb({ manifest, segmentStore, dbPath: restoredPath });

  const restored = new Database(restoredPath);
  const row = restored.prepare('SELECT v FROM t WHERE id = 1').get();
  assert.equal(row.v, 'hello');
  restored.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/restore.test.js
```

Expected: FAIL — `src/restore.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// phase2/packages/sqlite-s3/src/restore.js
import { writeFile, appendFile, rm } from 'node:fs/promises';

export async function restoreLocalDb({ manifest, segmentStore, dbPath }) {
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });

  if (!manifest || !manifest.baseSegmentId) {
    return; // no base snapshot yet — a fresh database, nothing to restore
  }

  const base = await segmentStore.getSegment(manifest.baseSegmentId);
  await writeFile(dbPath, base.bytes);

  for (const walSegmentId of manifest.walSegmentIds) {
    const seg = await segmentStore.getSegment(walSegmentId);
    await appendFile(`${dbPath}-wal`, seg.bytes);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd phase2/packages/sqlite-s3 && node --test test/restore.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add package.json package-lock.json src/restore.js test/restore.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: add local restore from manifest + segments

Reconstructs <db> and <db>-wal from a base snapshot segment plus the
ordered WAL segments, then lets SQLite's own WAL recovery finish the
job on open. Verified against real better-sqlite3-produced WAL bytes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

### Task 8: Knex client wiring

**Files:**
- Create: `phase2/packages/sqlite-s3/src/knex-client.js`
- Create: `phase2/packages/sqlite-s3/src/index.js`
- Test: `phase2/packages/sqlite-s3/test/knex-client.test.js`

**Interfaces:**
- Consumes: `restoreLocalDb` (Task 7), `createCommitter` (Task 5), `parseWalHeader`/`parseFrames` (Task 1), `createManifestStore`/`createSegmentStore` (Tasks 3-4), `createCheckpointPolicy` (Task 6).
- Produces: `SqliteS3Client` (a Knex `Client` subclass) and `index.js` re-exporting it plus every factory above for use in a Knex `client` config's `connection.s3` block.

Knex's internal module path for its built-in `better-sqlite3` client is not public API and can shift between Knex versions. **Before writing this task's code**, verify the actual path against the installed Knex version:

- [ ] **Step 1: Verify the Knex better-sqlite3 client's internal path and shape**

```bash
cd phase2/packages/sqlite-s3 && node -e "
const knexPkg = require.resolve('knex/package.json');
console.log('knex version:', require(knexPkg).version);
const Client = require('knex/lib/dialects/better-sqlite3/index.js').default ?? require('knex/lib/dialects/better-sqlite3/index.js');
console.log('resolved client:', typeof Client);
"
```

If this path doesn't resolve, run `node -e "console.log(Object.keys(require('knex/lib/dialects')))"` to find the correct directory name for the installed version, and use that in Step 3 instead. Record whichever path actually worked as a one-line comment above the import in `knex-client.js`.

- [ ] **Step 2: Write the failing test**

This test exercises the full loop without Docker or real S3: real `better-sqlite3` via Knex, in-memory object store, two sequential "processes" (fresh `SqliteS3Client` instances pointed at different local file paths) to prove data survives a simulated restart.

```js
// phase2/packages/sqlite-s3/test/knex-client.test.js
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
import { SqliteS3Client } from '../src/knex-client.js';

async function tmpDbPath() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sqlite-s3-knex-test-'));
  return path.join(dir, 'app.db');
}

function makeS3Config(store) {
  return {
    manifestStore: createManifestStore(store),
    segmentStore: createSegmentStore(store),
    checkpointPolicy: createCheckpointPolicy({ maxWalBytes: 10_000_000, maxIntervalMs: 3_600_000 }),
  };
}

function makeKnex(dbPath, s3Config) {
  return knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: s3Config },
    useNullAsDefault: true,
  });
}

test('data written via one Knex instance is visible after a simulated restart', async () => {
  const store = createInMemoryObjectStore();
  const dbPathA = await tmpDbPath();

  const knexA = makeKnex(dbPathA, makeS3Config(store));
  await knexA.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
  });
  await knexA('posts').insert({ title: 'hello world' });
  await knexA.destroy();

  // Simulate a restart: new process, new local file path, same S3-backed store.
  const dbPathB = await tmpDbPath();
  const knexB = makeKnex(dbPathB, makeS3Config(store));
  const rows = await knexB('posts').select('*');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'hello world');
  await knexB.destroy();
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js
```

Expected: FAIL — `src/knex-client.js` does not exist.

- [ ] **Step 4: Write the implementation**

```js
// phase2/packages/sqlite-s3/src/knex-client.js
// Verified against knex@<version from Step 1> — adjust this import if it stops resolving.
import BetterSQLite3Client from 'knex/lib/dialects/better-sqlite3/index.js';
import { statSync, readSync, openSync, closeSync } from 'node:fs';
import { restoreLocalDb } from './restore.js';
import { createCommitter } from './commit.js';
import { parseWalHeader, parseFrames } from './wal.js';

export class SqliteS3Client extends BetterSQLite3Client {
  constructor(config) {
    super(config);
    this._s3 = config.connection.s3;
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
    this._lastWalOffset = 0;
    this._pageSize = null;
    return super.acquireRawConnection();
  }

  async _query(connection, obj) {
    const result = await super._query(connection, obj);
    if (connection.inTransaction === false) {
      await this._maybeCaptureCommit(connection);
    }
    return result;
  }

  async _maybeCaptureCommit() {
    const walPath = `${this.connectionSettings.filename}-wal`;
    let size;
    try {
      size = statSync(walPath).size;
    } catch {
      return; // no WAL file yet (e.g. a read-only autocommit statement before any write)
    }
    if (size <= this._lastWalOffset) return;

    const delta = Buffer.alloc(size - this._lastWalOffset);
    const fd = openSync(walPath, 'r');
    readSync(fd, delta, 0, delta.length, this._lastWalOffset);
    closeSync(fd);

    const isFirstCapture = this._lastWalOffset === 0;
    if (isFirstCapture) {
      this._pageSize = parseWalHeader(delta).pageSize;
    }
    const frames = parseFrames(delta, this._pageSize, isFirstCapture ? 32 : 0);
    this._lastWalOffset = size;

    const committer = createCommitter({
      manifestStore: this._s3.manifestStore,
      segmentStore: this._s3.segmentStore,
    });
    const outcome = await committer.commitWalDelta(delta, frames);
    this._s3.checkpointPolicy.recordSegment(delta.length);

    if (outcome.retryTransaction) {
      throw new Error(
        'sqlite-s3: write conflict detected on commit — caller must retry the transaction'
      );
    }
  }
}
```

```js
// phase2/packages/sqlite-s3/src/index.js
export { SqliteS3Client } from './knex-client.js';
export { createManifestStore, ManifestConflictError } from './manifest.js';
export { createSegmentStore } from './segments.js';
export { createCheckpointPolicy } from './checkpoint.js';
export { createInMemoryObjectStore, createS3ObjectStore } from './object-store.js';
export { restoreLocalDb } from './restore.js';
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd phase2/packages/sqlite-s3 && node --test test/knex-client.test.js
```

Expected: PASS, 1 test. If the import from Step 1 needed adjusting, this is where that surfaces — fix the import path and re-run before moving on.

- [ ] **Step 6: Run the full unit test suite**

```bash
cd phase2/packages/sqlite-s3 && npm test
```

Expected: PASS, all tests across all files from Tasks 1-8.

- [ ] **Step 7: Commit**

```bash
cd phase2/packages/sqlite-s3 && git add src/knex-client.js src/index.js test/knex-client.test.js && git commit -m "$(cat <<'EOF'
sqlite-s3: add Knex client wiring restore-on-connect and commit capture

SqliteS3Client wraps Knex's built-in better-sqlite3 client: restores
local db+wal from the S3 manifest before the first query, and after
every query where the underlying connection has left a transaction
(better-sqlite3's inTransaction flips to false on commit or after an
autocommit write), ships the new WAL bytes through the commit
orchestrator. No Ghost-visible config shape changes — this is a normal
Knex client.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

### Task 9: Docker smoke test against real S3

**Files:**
- Create: `phase2/packages/sqlite-s3/smoke/create-bucket.sh`
- Create: `phase2/packages/sqlite-s3/smoke/docker-compose.smoke.yaml`
- Create: `phase2/packages/sqlite-s3/smoke/run-smoke-test.sh`

**Interfaces:**
- Consumes: the published `SqliteS3Client`/`index.js` from Task 8, wired into the forked Ghost image's Knex config via `database__client` pointed at this package and `database__connection__s3` env-driven settings.

This task is manual/operational verification, not `node --test` coverage — its "test" is the documented run producing the expected console output.

- [ ] **Step 1: Write the bucket-creation script**

```bash
#!/usr/bin/env bash
# phase2/packages/sqlite-s3/smoke/create-bucket.sh
set -euo pipefail

BUCKET_NAME="${1:?usage: create-bucket.sh <bucket-name> <region>}"
REGION="${2:?usage: create-bucket.sh <bucket-name> <region>}"

if [ "$REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION"
else
  aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
fi

aws s3api put-bucket-tagging --bucket "$BUCKET_NAME" --tagging \
  'TagSet=[{Key=purpose,Value=sqlite-s3-smoke-test},{Key=throwaway,Value=true}]'

echo "Created throwaway bucket: $BUCKET_NAME (region $REGION)"
echo "Remember to delete it after the smoke test:"
echo "  aws s3 rb s3://$BUCKET_NAME --force"
```

```bash
chmod +x phase2/packages/sqlite-s3/smoke/create-bucket.sh
```

- [ ] **Step 2: Write the smoke-test compose file**

Uses the forked `Ghost/` image (built from the existing submodule per `hi3zi`'s decision) with `database__client` pointed at this package instead of plain `sqlite3`. The exact env var names Ghost's config loader expects for a non-stock Knex client should be checked against `Ghost/core/core/shared/config/*` before finalizing — Ghost's `nconf`-based config only knows the client packages it ships with, so this will likely need Ghost's config-loading step patched (or a thin JS entry file that calls `knex()` directly with `client: SqliteS3Client` bypassing Ghost's client-name resolution) rather than a plain env var. Treat that as the first thing to validate when running this task, and update this compose file/README accordingly once confirmed — don't guess the exact wiring here.

```yaml
# phase2/packages/sqlite-s3/smoke/docker-compose.smoke.yaml
services:
  ghost-sqlite-s3:
    build:
      context: ../../../../Ghost
      dockerfile: Dockerfile
    environment:
      SQLITE_S3_BUCKET: "${SQLITE_S3_BUCKET:?set to the bucket from create-bucket.sh}"
      SQLITE_S3_REGION: "${SQLITE_S3_REGION:?set to the bucket's region}"
      AWS_ACCESS_KEY_ID: "${AWS_ACCESS_KEY_ID:?}"
      AWS_SECRET_ACCESS_KEY: "${AWS_SECRET_ACCESS_KEY:?}"
      AWS_SESSION_TOKEN: "${AWS_SESSION_TOKEN:-}"
    ports:
      - "2368:2368"
```

- [ ] **Step 3: Write the smoke test runner**

```bash
#!/usr/bin/env bash
# phase2/packages/sqlite-s3/smoke/run-smoke-test.sh
set -euo pipefail
cd "$(dirname "$0")"

: "${SQLITE_S3_BUCKET:?set SQLITE_S3_BUCKET first, e.g. from create-bucket.sh output}"
: "${SQLITE_S3_REGION:?set SQLITE_S3_REGION}"

echo "== Starting Ghost against $SQLITE_S3_BUCKET =="
docker compose -f docker-compose.smoke.yaml up -d --build

echo "== Waiting for Ghost to come up =="
for i in $(seq 1 30); do
  if curl -sf http://localhost:2368 > /dev/null; then break; fi
  sleep 2
done

echo "== Creating a test post via Ghost's Admin API (adjust to actual setup flow) =="
# Manual step today: log into /ghost, create one post named "smoke-test-post".
echo "Create a post titled 'smoke-test-post' via http://localhost:2368/ghost, then press enter."
read -r

echo "== Restarting the container (simulates a Lightsail redeploy with no persistent disk) =="
docker compose -f docker-compose.smoke.yaml restart ghost-sqlite-s3

echo "== Waiting for Ghost to come back up =="
for i in $(seq 1 30); do
  if curl -sf http://localhost:2368 > /dev/null; then break; fi
  sleep 2
done

echo "== Verify: check http://localhost:2368 still shows 'smoke-test-post' =="
curl -s http://localhost:2368 | grep -q 'smoke-test-post' \
  && echo "PASS: post survived restart" \
  || { echo "FAIL: post missing after restart"; exit 1; }

echo "== Cleanup reminder =="
echo "docker compose -f docker-compose.smoke.yaml down"
echo "aws s3 rb s3://$SQLITE_S3_BUCKET --force"
```

```bash
chmod +x phase2/packages/sqlite-s3/smoke/run-smoke-test.sh
```

- [ ] **Step 4: Run it for real**

```bash
cd phase2/packages/sqlite-s3/smoke
BUCKET="ghost-sqlite-s3-smoke-$(date +%s)"
./create-bucket.sh "$BUCKET" us-east-1
export SQLITE_S3_BUCKET="$BUCKET"
export SQLITE_S3_REGION=us-east-1
./run-smoke-test.sh
```

Expected: `PASS: post survived restart`. If Ghost's config loader rejects the custom client (per the Step 2 caveat), resolve that wiring first — this is the one part of the plan with a genuine unknown, flagged rather than guessed.

- [ ] **Step 5: Clean up and commit**

```bash
docker compose -f phase2/packages/sqlite-s3/smoke/docker-compose.smoke.yaml down
aws s3 rb "s3://$BUCKET" --force
cd /home/doo/projects/ghost
git add phase2/packages/sqlite-s3/smoke && git commit -m "$(cat <<'EOF'
sqlite-s3: add docker smoke test against a real throwaway S3 bucket

Verifies restart-survival end to end: create bucket via aws cli, run
Ghost against it, write a post, restart the container (simulating a
Lightsail redeploy with no persistent disk), confirm the post is still
there.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AkUP26qucd1dCSXy7gDMon
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** base segment (Task 3/7), WAL segments (Task 1/3), manifest+CAS (Task 4), multi-writer OCC commit path incl. retry budget (Task 5), checkpoint policy (Task 6), startup restore (Task 7), Knex integration point (Task 8), smoke test w/ real bucket via aws cli (Task 9) — every spec section maps to a task.
- **Placeholder scan:** no TBD/TODO left in code; the one genuine open unknown (how Ghost's config loader accepts a non-stock Knex client) is called out explicitly in Task 9 as something to resolve during that task, not glossed over — this is a real integration unknown the design doc's "accepted risk" already flagged, not a plan gap.
- **Type/name consistency:** `ObjectStore.get/put` shape, `SegmentStore.putSegment/getSegment`, `ManifestStore.read/write`, `ManifestConflictError.current`, `Committer.commitWalDelta`, `CheckpointPolicy.recordSegment/shouldCheckpoint/recordCheckpoint`, `restoreLocalDb`, and `SqliteS3Client` are used with the same names and shapes everywhere they're consumed across tasks.
