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
import { SqliteS3Client, registerS3Config } from '../src/knex-client.js';

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

test('a checkpoint runs when the policy says to, and merges accumulated commits into a new base segment', async () => {
  const store = createInMemoryObjectStore();
  const dbPathA = await tmpDbPath();

  // A checkpoint policy that says "checkpoint" as soon as ANY bytes have
  // been recorded, so this test doesn't depend on real size/time thresholds.
  const manifestStore = createManifestStore(store);
  const segmentStore = createSegmentStore(store);
  let recorded = 0;
  const checkpointPolicy = {
    recordSegment: (n) => { recorded += n; },
    shouldCheckpoint: () => recorded > 0,
    recordCheckpoint: () => { recorded = 0; },
  };

  const knexA = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPathA, s3: { manifestStore, segmentStore, checkpointPolicy } },
    useNullAsDefault: true,
  });
  await knexA.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
  });
  await knexA('posts').insert({ title: 'hello' });
  await knexA.destroy();

  const { manifest } = await manifestStore.read();
  assert.ok(manifest.baseSegmentId, 'a base segment must exist after a checkpoint ran');
  assert.deepEqual(manifest.walSegmentIds, [], 'wal segments must be cleared after checkpointing');

  // Data must still be intact after the checkpoint, from a fresh instance.
  const dbPathB = await tmpDbPath();
  const knexB = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPathB, s3: { manifestStore, segmentStore, checkpointPolicy: makeS3Config(store).checkpointPolicy } },
    useNullAsDefault: true,
  });
  const rows = await knexB('posts').select('*');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'hello');
  await knexB.destroy();
});

test('a checkpoint failure does not break the caller\'s actual write', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const segmentStore = createSegmentStore(store);
  const manifestStore = {
    read: async () => { throw new Error('boom: simulated checkpoint read failure'); },
    write: createManifestStore(store).write,
  };
  const checkpointPolicy = {
    recordSegment: () => {},
    shouldCheckpoint: () => true, // always try to checkpoint
    recordCheckpoint: () => {},
  };

  // Use a SEPARATE, working manifestStore for the actual commit path, and only
  // make performCheckpoint's own read() call fail — simulate this by using a
  // real manifestStore for commits but asserting the write still succeeds
  // even though checkpointing will throw internally when it tries to read.
  const realManifestStore = createManifestStore(store);
  const knex = knexFactory({
    client: SqliteS3Client,
    connection: {
      filename: dbPath,
      s3: {
        manifestStore: realManifestStore,
        segmentStore,
        checkpointPolicy: {
          recordSegment: () => {},
          shouldCheckpoint: () => { throw new Error('boom: simulated checkpoint policy failure'); },
          recordCheckpoint: () => {},
        },
      },
    },
    useNullAsDefault: true,
  });

  await knex.schema.createTable('posts', (t) => {
    t.increments('id');
  });
  // If checkpoint wiring isn't wrapped in try/catch, this insert would reject.
  await knex('posts').insert({});
  const rows = await knex('posts').select('*');
  assert.equal(rows.length, 1);
  await knex.destroy();
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

// Task 4: transaction() reconciliation. The brief's own test sketch used a
// mocked manifestStore.write that didn't force a REAL page-level conflict
// (it was flagged as needing adjustment). This version forces a genuine
// conflict by having a completely separate writer instance (knexB) commit a
// real, independent update to the EXACT SAME ROW that knexA's transaction is
// also updating, in the narrow window between knexA's manifest read and its
// manifest write landing. Because both writers touch the same SQLite page,
// commit.js's overlap check is guaranteed to detect a real conflict (not
// merely a manifest-etag race it could silently fast-forward past), so this
// exercises the actual reconciliation path rather than an artificial one.
test('a knex.transaction() callback is safely re-invoked against fresh state after losing a conflict race', async () => {
  const store = createInMemoryObjectStore();
  // Both writers below get their own manifestStore/segmentStore/checkpointPolicy
  // instances (as two real, independent writer processes would), all backed
  // by the same underlying shared S3 object store.
  const s3ConfigA = makeS3Config(store);
  const manifestStoreA = s3ConfigA.manifestStore;

  const dbPathA = await tmpDbPath();
  const knexA = makeKnex(dbPathA, s3ConfigA);

  await knexA.schema.createTable('counters', (t) => {
    t.string('name').primary();
    t.integer('value');
  });
  await knexA('counters').insert({ name: 'hits', value: 0 });

  // Knex builds a lightweight "trxClient" clone for every query run inside
  // knex.transaction() (see node_modules/knex/lib/execution/transaction.js's
  // makeTxClient) that shares SqliteS3Client's prototype but skips the
  // constructor, so it never gets its own `_s3`. `_maybeCaptureCommit`
  // already falls back to the module-level registry for exactly this case
  // (see its comment) — register knexA's config so the COMMIT query (which
  // runs through that trxClient) can find it. Reset it after this test so it
  // doesn't leak into other tests in this file.
  registerS3Config(s3ConfigA);

  // From this point on, intercept knexA's manifest writes. On the FIRST
  // call (made by the transaction under test below), let a totally separate
  // writer (knexB) commit a real, independent change to the SAME row first,
  // so that knexA's own write — still carrying the etag it read before
  // knexB's write landed — genuinely loses the CAS race.
  let writeAttempts = 0;
  const realWriteA = manifestStoreA.write.bind(manifestStoreA);
  manifestStoreA.write = async (manifest, opts) => {
    writeAttempts += 1;
    if (writeAttempts === 1) {
      const dbPathB = await tmpDbPath();
      const knexB = makeKnex(dbPathB, makeS3Config(store));
      await knexB('counters').where({ name: 'hits' }).update({ value: 100 });
      await knexB.destroy();
    }
    return realWriteA(manifest, opts);
  };

  let attemptCount = 0;
  try {
    const result = await knexA.transaction(async (trx) => {
      attemptCount += 1;
      const row = await trx('counters').where({ name: 'hits' }).first();
      await trx('counters').where({ name: 'hits' }).update({ value: row.value + 1 });
      return row.value + 1;
    });

    assert.equal(writeAttempts, 2, 'the manifest write must have genuinely conflicted once, then succeeded on retry');
    assert.equal(attemptCount, 2, 'the transaction callback must have been re-invoked exactly once after the conflict');
    // The retried callback must have observed knexB's committed value (100),
    // proving it ran against genuinely fresh state restored from S3 — not the
    // stale value (0) the first attempt saw, and not zero re-invocations.
    assert.equal(result, 101, 'the result must reflect exactly one increment applied on top of the fresh (post-conflict) state, not zero or double-applied');

    const finalRow = await knexA('counters').where({ name: 'hits' }).first();
    assert.equal(finalRow.value, 101, 'exactly one increment must be reflected on top of the fresh state, not zero or double-counted');
  } finally {
    registerS3Config(undefined);
    await knexA.destroy();
  }
});
