import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knexFactory from 'knex';
import {
  SqliteS3Client,
  createManifestStore,
  createSegmentStore,
  createCheckpointPolicy,
  createLeaseStore,
  createS3ObjectStore,
} from '../../src/index.js';

async function tmpDbPath() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sqlite-s3-e2e-'));
  return path.join(dir, 'app.db');
}

// Every writer in a scenario shares the same bucket, so they must also
// share the same manifest/segment stores and checkpoint policy — this
// is exactly how the package is meant to be used by multiple real
// processes pointed at the same S3 location.
function s3Config(world) {
  if (!world.sharedS3Config) {
    const objectStore = createS3ObjectStore({ bucket: world.bucketName, client: world.s3Client });
    world.sharedS3Config = {
      manifestStore: createManifestStore(objectStore),
      segmentStore: createSegmentStore(objectStore),
      checkpointPolicy: createCheckpointPolicy({ maxWalBytes: 50_000_000, maxIntervalMs: 3_600_000 }),
      leaseStore: createLeaseStore(objectStore),
    };
  }
  return world.sharedS3Config;
}

async function newKnex(world) {
  const dbPath = await tmpDbPath();
  const knex = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: s3Config(world) },
    useNullAsDefault: true,
  });
  world.trackKnex(knex);
  return knex;
}

Given('a throwaway S3 bucket for this test run', function () {
  // The Before hook (support/hooks.js) already created and tagged the
  // bucket before this step runs — this step just documents intent and
  // sanity-checks the hook actually ran.
  assert.ok(this.bucketName, 'expected the Before hook to have set a bucket name');
});

Given('a shared {string} table created by a bootstrap writer', async function (tableName) {
  const knex = await newKnex(this);
  await knex.schema.createTable(tableName, (t) => {
    t.increments('id');
    t.integer('writer').notNullable();
    t.integer('seq').notNullable();
    t.string('value').notNullable();
  });
  this.tableName = tableName;
});

When(
  '{int} concurrent writers each insert {int} rows into {string} via reconciling transactions',
  async function (writerCount, rowsPerWriter, tableName) {
    assert.equal(tableName, this.tableName, 'scenario wired to a different table than it created');

    const writers = await Promise.all(
      Array.from({ length: writerCount }, () => newKnex(this))
    );

    // Each writer commits its rows through knex.transaction() with the
    // opt-in reconciliation flag. All writers targeting the same fresh
    // table will genuinely contend for the same few b-tree pages (and,
    // absent reconciliation, could collide on locally-assigned rowids
    // too) — this is real page-level contention, not simulated, which
    // is exactly what reconciliation exists to resolve: a lost
    // conflict race restores fresh state and re-runs this callback,
    // so a retried insert picks a genuinely free rowid against
    // current data rather than replaying a stale one.
    await Promise.all(
      writers.map(async (knex, writerIndex) => {
        for (let seq = 0; seq < rowsPerWriter; seq += 1) {
          await knex.transaction(
            async (trx) => {
              await trx(tableName).insert({ writer: writerIndex, seq, value: `w${writerIndex}-r${seq}` });
            },
            { sqliteS3Reconcile: true }
          );
        }
      })
    );

    this.expectedRowCount = writerCount * rowsPerWriter;
    this.writerCount = writerCount;
    this.rowsPerWriter = rowsPerWriter;
  }
);

Then('all {int} rows are present, one per \\(writer, sequence\\) pair, with none lost or duplicated', async function (expectedCount) {
  assert.equal(expectedCount, this.expectedRowCount, 'feature file and step disagree on expected row count');

  const reader = await newKnex(this);
  const rows = await reader(this.tableName).select('writer', 'seq', 'value');

  assert.equal(rows.length, expectedCount, `expected exactly ${expectedCount} rows, found ${rows.length}`);

  const seen = new Set();
  for (const row of rows) {
    const key = `${row.writer}:${row.seq}`;
    assert.ok(!seen.has(key), `duplicate row for writer ${row.writer} seq ${row.seq}`);
    seen.add(key);
    assert.equal(row.value, `w${row.writer}-r${row.seq}`, `row content mismatch for writer ${row.writer} seq ${row.seq}`);
  }

  for (let writer = 0; writer < this.writerCount; writer += 1) {
    for (let seq = 0; seq < this.rowsPerWriter; seq += 1) {
      const key = `${writer}:${seq}`;
      assert.ok(seen.has(key), `writer ${writer}'s row seq ${seq} is missing — a commit was silently lost`);
    }
  }
});

When('a brand new client starts fresh with no local database and connects to the same bucket', async function () {
  // A genuinely fresh local path this process has never touched —
  // proves restore is driven entirely by S3 state, not any leftover
  // local file from an earlier step.
  this.freshClient = await newKnex(this);
});

Then('it sees all {int} rows in {string}', async function (expectedCount, tableName) {
  const rows = await this.freshClient(tableName).select('*');
  assert.equal(rows.length, expectedCount, `fresh client expected ${expectedCount} rows, found ${rows.length}`);
});
