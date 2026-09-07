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

// Regression test for C1: after restoreLocalDb reconstructs a non-empty
// `-wal` file from the manifest's segments, _lastWalOffset must start at
// that file's actual size, not 0 — otherwise the next capture re-ships the
// entire restored WAL history as a duplicate segment, and a SECOND restart
// halts WAL recovery at that duplicate segment's unexpected embedded WAL
// header, silently losing every write made between the first and second
// restart.
test('data survives two successive simulated restarts (C1: no duplicate-shipping of restored WAL)', async () => {
  const store = createInMemoryObjectStore();
  const dbPathA = await tmpDbPath();

  const knexA = makeKnex(dbPathA, makeS3Config(store));
  await knexA.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
  });
  await knexA('posts').insert({ title: 'first instance' });
  await knexA.destroy();

  // First simulated restart: restore from S3, then write more data.
  const dbPathB = await tmpDbPath();
  const knexB = makeKnex(dbPathB, makeS3Config(store));
  await knexB('posts').insert({ title: 'second instance' });
  await knexB.destroy();

  // Second simulated restart: restore from S3 again.
  const dbPathC = await tmpDbPath();
  const knexC = makeKnex(dbPathC, makeS3Config(store));
  const rows = await knexC('posts').select('*').orderBy('id');
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.title),
    ['first instance', 'second instance']
  );
  await knexC.destroy();
});

// Regression test for I3: the pool must always be pinned to exactly one
// connection, regardless of what's passed in `config.pool` — otherwise a
// second pooled connection could acquire concurrently and delete the local
// database out from under the first connection's in-progress work.
test('pool is pinned to min:1, max:1 regardless of what is passed in config.pool', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();

  const knex = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: makeS3Config(store) },
    useNullAsDefault: true,
    pool: { min: 5, max: 20 },
  });
  try {
    assert.deepEqual(knex.client.config.pool, { min: 1, max: 1 });
    assert.equal(knex.client.pool.min, 1);
    assert.equal(knex.client.pool.max, 1);
  } finally {
    await knex.destroy();
  }
});

// Regression test for I4: frames a rolled-back transaction spilled into the
// WAL before rolling back must never be shipped as a durable segment, and a
// real committed write landing after them must never be silently dropped.
test('a rolled-back transaction is not shipped, and a subsequent real commit survives a restart (I4)', async () => {
  const store = createInMemoryObjectStore();
  const dbPathA = await tmpDbPath();

  const knexA = makeKnex(dbPathA, makeS3Config(store));
  await knexA.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
  });

  // Drive raw SQL through Knex's own query path (not a direct raw-connection
  // call) so the client's `_query` hook — and thus `_maybeCaptureCommit` —
  // actually fires after the ROLLBACK, exactly as it would in production.
  await knexA.raw('BEGIN');
  await knexA.raw("insert into posts (title) values ('rolled back row')");
  await knexA.raw('ROLLBACK');

  // Now perform a real, committed write.
  await knexA('posts').insert({ title: 'committed row' });
  await knexA.destroy();

  const dbPathB = await tmpDbPath();
  const knexB = makeKnex(dbPathB, makeS3Config(store));
  const rows = await knexB('posts').select('*');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'committed row');
  await knexB.destroy();
});
