import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createManifestStore } from '../src/manifest.js';
import { createSegmentStore } from '../src/segments.js';
import { seedStoreFromSqliteFile, readPageSize } from '../src/seed.js';

async function makeDb(pageSize = 4096) {
  const dir = await mkdtemp(path.join(tmpdir(), 'seed-test-'));
  const dbPath = path.join(dir, 'source.db');
  const db = new Database(dbPath);
  db.pragma(`page_size = ${pageSize}`);
  db.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO posts (title) VALUES (?)').run('hello');
  db.close();
  return dbPath;
}

test('readPageSize reads the page size out of the SQLite header', async () => {
  const dbPath = await makeDb(8192);
  assert.equal(readPageSize(await readFile(dbPath)), 8192);
});

test('readPageSize decodes the 65536 special case', () => {
  const header = Buffer.alloc(100);
  header.write('SQLite format 3 ', 0, 'latin1');
  header.writeUInt16BE(1, 16);
  assert.equal(readPageSize(header), 65536);
});

test('readPageSize rejects a file too short to hold a header', () => {
  assert.throws(() => readPageSize(Buffer.alloc(4)), /not a SQLite database/);
});

test('seedStoreFromSqliteFile writes a base segment and an initial manifest', async () => {
  const dbPath = await makeDb();
  const store = createInMemoryObjectStore();
  const manifestStore = createManifestStore(store);
  const segmentStore = createSegmentStore(store);

  const result = await seedStoreFromSqliteFile({ dbPath, manifestStore, segmentStore });

  assert.equal(result.pageSize, 4096);
  assert.ok(result.baseSegmentId);
  assert.ok(result.bytes > 0);

  const { manifest } = await manifestStore.read();
  assert.deepEqual(manifest, {
    baseSegmentId: result.baseSegmentId,
    walSegmentIds: [],
    pageSize: 4096,
  });

  const segment = await segmentStore.getSegment(result.baseSegmentId);
  assert.deepEqual(Buffer.from(segment.bytes), await readFile(dbPath));
});

test('seedStoreFromSqliteFile refuses to overwrite an existing store', async () => {
  const dbPath = await makeDb();
  const store = createInMemoryObjectStore();
  const manifestStore = createManifestStore(store);
  const segmentStore = createSegmentStore(store);

  await seedStoreFromSqliteFile({ dbPath, manifestStore, segmentStore });

  await assert.rejects(
    () => seedStoreFromSqliteFile({ dbPath, manifestStore, segmentStore }),
    /already seeded/
  );
});

test('seedStoreFromSqliteFile rejects a file that is not a SQLite database', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seed-test-'));
  const dbPath = path.join(dir, 'garbage.db');
  await writeFile(dbPath, Buffer.alloc(200, 0x41));

  const store = createInMemoryObjectStore();
  await assert.rejects(
    () =>
      seedStoreFromSqliteFile({
        dbPath,
        manifestStore: createManifestStore(store),
        segmentStore: createSegmentStore(store),
      }),
    /not a SQLite database/
  );
});
