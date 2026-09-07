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
