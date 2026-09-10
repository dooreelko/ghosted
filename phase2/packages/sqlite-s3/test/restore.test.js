import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { createLeaseStore } from '../src/leases.js';
import { restoreLocalDb } from '../src/restore.js';
import { parseWalHeader, parseFrames } from '../src/wal.js';
import { extractPageImages, encodePageImages, decodePageImages } from '../src/page-images.js';

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
  const objectStore = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);
  await restoreLocalDb({ manifest: null, segmentStore, leaseStore, dbPath });
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

  const objectStore = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);
  const baseSegmentId = await segmentStore.putSegment(baseBytes);
  const walSegmentId = await segmentStore.putSegment(payload, { dbSizeAfterCommit });
  const manifest = { baseSegmentId, walSegmentIds: [walSegmentId], pageSize };

  const restoredPath = await tmpPath('restored.db');
  await restoreLocalDb({ manifest, segmentStore, leaseStore, dbPath: restoredPath });

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

  const objectStore = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);
  const walSegmentId = await segmentStore.putSegment(payload, { dbSizeAfterCommit });
  const manifest = { baseSegmentId: null, walSegmentIds: [walSegmentId], pageSize };

  const restoredPath = await tmpPath('restored-nobase.db');
  await restoreLocalDb({ manifest, segmentStore, leaseStore, dbPath: restoredPath });

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
  // its own random header salts, unrelated to writer A's) that synced the
  // current state (base + writer A's commit — table t must already exist
  // for writer B to insert into it) and added a second row. Simulate this by
  // restoring base+segA into a fresh file via restoreLocalDb itself (already
  // verified correct by the earlier tests), then writing through it.
  const preObjectStore = createInMemoryObjectStore();
  const preSegmentStore = createSegmentStore(preObjectStore);
  const preLeaseStore = createLeaseStore(preObjectStore);
  const preBaseSegmentId = await preSegmentStore.putSegment(baseBytes);
  const preSegAId = await preSegmentStore.putSegment(segA.payload, { dbSizeAfterCommit: segA.dbSizeAfterCommit });
  const writerBPath = await tmpPath('writerB.db');
  await restoreLocalDb({
    manifest: { baseSegmentId: preBaseSegmentId, walSegmentIds: [preSegAId], pageSize: segA.pageSize },
    segmentStore: preSegmentStore,
    leaseStore: preLeaseStore,
    dbPath: writerBPath,
  });
  const dbB = new Database(writerBPath);
  dbB.pragma('journal_mode = WAL');
  dbB.prepare('INSERT INTO t (v) VALUES (?)').run('from B');
  const segB = await walFileToPageImageSegment(`${writerBPath}-wal`);
  dbB.close();

  // Both writers' segments land in one shared manifest, in commit order.
  const objectStore = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);
  const baseSegmentId = await segmentStore.putSegment(baseBytes);
  const segAId = await segmentStore.putSegment(segA.payload, { dbSizeAfterCommit: segA.dbSizeAfterCommit });
  const segBId = await segmentStore.putSegment(segB.payload, { dbSizeAfterCommit: segB.dbSizeAfterCommit });
  const manifest = {
    baseSegmentId,
    walSegmentIds: [segAId, segBId],
    pageSize: segA.pageSize,
  };

  const restoredPath = await tmpPath('restored-multiwriter.db');
  await restoreLocalDb({ manifest, segmentStore, leaseStore, dbPath: restoredPath });

  const restored = new Database(restoredPath);
  const rows = restored.prepare('SELECT v FROM t ORDER BY id').all();
  // Both writers' rows must be present — this is exactly what raw WAL-byte
  // segments could not guarantee (writer B's segment would corrupt recovery
  // at the point it was spliced onto writer A's WAL, per final-review C2).
  assert.deepEqual(rows.map((r) => r.v).sort(), ['from A', 'from B']);
  restored.close();
});

test('restoreLocalDb truncates to the MAXIMUM dbSizeAfterCommit across all segments, not the last one (C-A regression)', async () => {
  // Build a base database with two tables: `t` (one seed row, small — its
  // root page never needs to grow) and `u` (empty). Checkpoint so the base
  // segment is a clean, WAL-free file.
  const basePath = await tmpPath('ca-base.db');
  const baseDb = new Database(basePath);
  baseDb.pragma('journal_mode = WAL');
  baseDb.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  baseDb.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, v TEXT)');
  baseDb.prepare('INSERT INTO t (v) VALUES (?)').run('seed');
  baseDb.pragma('wal_checkpoint(TRUNCATE)');
  baseDb.close();
  const baseBytes = await readFile(basePath);

  // Writer A: an independent copy of the base that inserts a large value
  // into `u`, forcing the database to grow by several pages. This is a
  // genuinely disjoint write-set from writer B below (verified in the
  // assertions further down) — real SQLite only rewrites page 1 (the file
  // header, which records the database's page count) when a transaction
  // actually changes that count, so A's commit touches page 1 plus the new
  // high-numbered pages it allocated.
  const aPath = await tmpPath('ca-a.db');
  await copyFile(basePath, aPath);
  const dbA = new Database(aPath);
  dbA.pragma('journal_mode = WAL');
  dbA.prepare('INSERT INTO u (v) VALUES (?)').run('X'.repeat(10000));
  const segA = await walFileToPageImageSegment(`${aPath}-wal`);
  dbA.close();

  // Writer B: a SEPARATE independent copy of the SAME base (a genuinely
  // divergent snapshot, not one that has seen writer A's commit) that only
  // updates the existing seed row in `t` in place. This does not allocate
  // any new page, so the database's page count is unchanged and page 1 is
  // never touched — writer B's write-set is just the one existing page
  // holding `t`'s data, which is guaranteed disjoint from A's.
  const bPath = await tmpPath('ca-b.db');
  await copyFile(basePath, bPath);
  const dbB = new Database(bPath);
  dbB.pragma('journal_mode = WAL');
  dbB.prepare('UPDATE t SET v = ? WHERE id = 1').run('updated-by-B');
  const segB = await walFileToPageImageSegment(`${bPath}-wal`);
  dbB.close();

  // Sanity-check the scenario this test depends on: the write-sets really
  // are disjoint, A really did grow the db, and B really didn't.
  const pagesA = new Set((await decodePageImages(segA.payload)).map((p) => p.pageNumber));
  const pagesB = new Set((await decodePageImages(segB.payload)).map((p) => p.pageNumber));
  assert.ok([...pagesA].every((p) => !pagesB.has(p)), 'writer A and writer B write-sets must be disjoint');
  assert.ok(segA.dbSizeAfterCommit > segB.dbSizeAfterCommit, 'writer A must grow the db past writer B\'s (stale) size');
  const baseSizePages = baseBytes.length / segA.pageSize;
  assert.equal(segB.dbSizeAfterCommit, baseSizePages, 'writer B must not grow the db at all');

  // Both writers' segments land in one shared manifest. Critically, A (the
  // LARGER dbSizeAfterCommit) is placed BEFORE B (the SMALLER, stale one) —
  // this is exactly the ordering that breaks a naive "last segment wins"
  // truncation rule, since it would truncate the restored file down to B's
  // smaller page count and discard every page A added.
  const objectStore = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);
  const baseSegmentId = await segmentStore.putSegment(baseBytes);
  const segAId = await segmentStore.putSegment(segA.payload, { dbSizeAfterCommit: segA.dbSizeAfterCommit });
  const segBId = await segmentStore.putSegment(segB.payload, { dbSizeAfterCommit: segB.dbSizeAfterCommit });
  const manifest = {
    baseSegmentId,
    walSegmentIds: [segAId, segBId],
    pageSize: segA.pageSize,
  };

  const restoredPath = await tmpPath('ca-restored.db');
  await restoreLocalDb({ manifest, segmentStore, leaseStore, dbPath: restoredPath });

  const restored = new Database(restoredPath);
  const integrity = restored.pragma('integrity_check');
  assert.deepEqual(integrity, [{ integrity_check: 'ok' }]);

  // Both writers' data must actually be present and queryable — not just
  // "the file opened without throwing".
  const tRow = restored.prepare('SELECT v FROM t WHERE id = 1').get();
  assert.equal(tRow.v, 'updated-by-B');
  const uRow = restored.prepare('SELECT v FROM u WHERE id = 1').get();
  assert.equal(uRow.v, 'X'.repeat(10000));
  restored.close();
});

test('restoreLocalDb throws a clear error when wal segments exist but manifest.pageSize is missing (I-B)', async () => {
  const objectStore = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);
  const walSegmentId = await segmentStore.putSegment(Buffer.from('irrelevant'), { dbSizeAfterCommit: 1 });
  const manifest = { baseSegmentId: null, walSegmentIds: [walSegmentId], pageSize: undefined };

  const restoredPath = await tmpPath('missing-pagesize.db');
  await assert.rejects(
    () => restoreLocalDb({ manifest, segmentStore, leaseStore, dbPath: restoredPath }),
    /manifest\.pageSize is missing or invalid/
  );
});

test('restoreLocalDb throws a clear error when manifest.pageSize disagrees with the base segment\'s own page size (I-C)', async () => {
  const sourcePath = await tmpPath('mismatch-source.db');
  const db = new Database(sourcePath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const baseBytes = await readFile(sourcePath);
  // The real file's own page size (read from its header) is 4096 (better-sqlite3's
  // default). Deliberately record a different pageSize in the manifest.
  const wrongPageSize = 8192;

  const objectStore = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);
  const baseSegmentId = await segmentStore.putSegment(baseBytes);
  const manifest = { baseSegmentId, walSegmentIds: [], pageSize: wrongPageSize };

  const restoredPath = await tmpPath('mismatch-restored.db');
  await assert.rejects(
    () => restoreLocalDb({ manifest, segmentStore, leaseStore, dbPath: restoredPath }),
    /does not match the base segment's own page size/
  );
});

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
