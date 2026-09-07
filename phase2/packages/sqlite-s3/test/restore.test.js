import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
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
  // its own random header salts, unrelated to writer A's) that synced the
  // current state (base + writer A's commit — table t must already exist
  // for writer B to insert into it) and added a second row. Simulate this by
  // restoring base+segA into a fresh file via restoreLocalDb itself (already
  // verified correct by the earlier tests), then writing through it.
  const preSegmentStore = createSegmentStore(createInMemoryObjectStore());
  const preBaseSegmentId = await preSegmentStore.putSegment(baseBytes);
  const preSegAId = await preSegmentStore.putSegment(segA.payload, { dbSizeAfterCommit: segA.dbSizeAfterCommit });
  const writerBPath = await tmpPath('writerB.db');
  await restoreLocalDb({
    manifest: { baseSegmentId: preBaseSegmentId, walSegmentIds: [preSegAId], pageSize: segA.pageSize },
    segmentStore: preSegmentStore,
    dbPath: writerBPath,
  });
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
