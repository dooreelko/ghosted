import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createManifestStore } from '../src/manifest.js';
import { createSegmentStore } from '../src/segments.js';
import { createLeaseStore } from '../src/leases.js';
import { seedStoreFromSqliteFile } from '../src/seed.js';
import { dumpStoreToSqliteFile } from '../src/dump.js';

async function tmpFile(name) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dump-test-'));
  return path.join(dir, name);
}

async function makeDb() {
  const dbPath = await tmpFile('source.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)');
  const insert = db.prepare('INSERT INTO posts (title) VALUES (?)');
  for (let i = 0; i < 50; i += 1) insert.run(`post ${i}`);
  db.close();
  return dbPath;
}

test('seed then dump round-trips the database byte for byte', async () => {
  const sourcePath = await makeDb();
  const store = createInMemoryObjectStore();
  const manifestStore = createManifestStore(store);
  const segmentStore = createSegmentStore(store);
  const leaseStore = createLeaseStore(store);

  await seedStoreFromSqliteFile({ dbPath: sourcePath, manifestStore, segmentStore });

  const outPath = await tmpFile('dumped.db');
  const result = await dumpStoreToSqliteFile({ manifestStore, segmentStore, leaseStore, dbPath: outPath });

  const source = await readFile(sourcePath);
  const dumped = await readFile(outPath);
  assert.deepEqual(dumped, source);
  assert.equal(result.bytes, source.length);
});

test('the dumped file is a queryable database with the same rows', async () => {
  const sourcePath = await makeDb();
  const store = createInMemoryObjectStore();
  const manifestStore = createManifestStore(store);
  const segmentStore = createSegmentStore(store);
  const leaseStore = createLeaseStore(store);
  await seedStoreFromSqliteFile({ dbPath: sourcePath, manifestStore, segmentStore });

  const outPath = await tmpFile('dumped.db');
  await dumpStoreToSqliteFile({ manifestStore, segmentStore, leaseStore, dbPath: outPath });

  const db = new Database(outPath, { readonly: true });
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM posts').get();
  db.close();
  assert.equal(n, 50);
});

test('dumping an empty store fails rather than writing a zero-byte file', async () => {
  const store = createInMemoryObjectStore();
  const outPath = await tmpFile('dumped.db');

  await assert.rejects(
    () =>
      dumpStoreToSqliteFile({
        manifestStore: createManifestStore(store),
        segmentStore: createSegmentStore(store),
        dbPath: outPath,
      }),
    /store is empty/
  );
});
