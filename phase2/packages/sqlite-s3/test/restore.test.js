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
