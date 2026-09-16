import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knexFactory from 'knex';
import { createS3ObjectStore } from '../../src/object-store.js';
import { createManifestStore } from '../../src/manifest.js';
import { createSegmentStore } from '../../src/segments.js';
import { createLeaseStore } from '../../src/leases.js';
import { createCheckpointPolicy } from '../../src/checkpoint.js';
import { SqliteS3Client } from '../../src/knex-client.js';

async function tmpDbPath() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sqlite-s3-e2e-contention-'));
  return path.join(dir, 'app.db');
}

function makeS3Config(world) {
  const objectStore = createS3ObjectStore({ bucket: world.bucketName, client: world.s3Client });
  return {
    manifestStore: createManifestStore(objectStore),
    segmentStore: createSegmentStore(objectStore),
    leaseStore: createLeaseStore(objectStore),
    checkpointPolicy: createCheckpointPolicy({ maxWalBytes: 10_000_000, maxIntervalMs: 3_600_000 }),
  };
}

async function makeWriter(world) {
  const dbPath = await tmpDbPath();
  const knex = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: makeS3Config(world) },
    useNullAsDefault: true,
  });
  return world.trackKnex(knex);
}

Given('a shared {string} table created by a bootstrap writer for the contention scenario', async function (tableName) {
  // Deliberately ONE writer/pool for the whole scenario, not one per
  // logical actor: the incident is a single Ghost process's single
  // Knex pool (SqliteS3Client pins pool to {min:1, max:1} — see
  // knex-client.js) serving both the automation-poll burst and the
  // sign-in write. Two separate SqliteS3Client instances (separate
  // local db files) would only interact through S3 manifest
  // optimistic-concurrency, not through a shared connection pool —
  // that's a different, already-handled contention path (see
  // multi-writer-reconciliation.feature) and would fail this
  // scenario for the wrong reason (a manifest CAS conflict on the
  // shared table's page, not queuing behind an S3 round-trip).
  const writer = await makeWriter(this);
  await writer.schema.createTable(tableName, (t) => {
    t.increments('id');
    t.string('label');
  });
  this.tableName = tableName;
  this.writer = writer;
});

When(
  'a burst writer starts inserting {int} rows into {string} one at a time, each via its own top-level statement',
  async function (count, tableName) {
    const writer = this.writer;
    // Fired without awaiting between statements (a real automation-poll
    // cascade issues its writes roughly together, not one full S3
    // round-trip apart) so every insert's connection-acquire request is
    // already queued behind the pinned single-connection pool
    // (SqliteS3Client pins pool to {min:1, max:1}) by the time the
    // concurrent writer's request joins that same queue below. Awaiting
    // sequentially here instead lets Knex's pool (tarn, strictly FIFO)
    // interleave fairly: the concurrent writer's request would always
    // land ahead of the burst writer's not-yet-issued next request and
    // so would only ever wait for ONE in-flight upload, never all of
    // them — verified empirically against this codebase before writing
    // this comment (see task-1-report.md for the walk-through).
    const insertPromises = [];
    for (let i = 0; i < count; i += 1) {
      insertPromises.push(Promise.resolve(writer(tableName).insert({ label: `burst-${i}` })));
    }
    this.firstBurstInsertDone = insertPromises[0];
    this.burstDone = Promise.all(insertPromises);
  }
);

When(
  'once the burst writer\'s first insert has committed locally, a concurrent writer inserts {int} row into {string}',
  async function (count, tableName) {
    await this.firstBurstInsertDone;
    // Same knex instance (same pinned single-connection pool) as the
    // burst writer — this is the "unrelated concurrent writer" from a
    // Ghost request handler's point of view, but it necessarily goes
    // through the one pool the whole process shares, exactly like the
    // real sign-in request did during the incident.
    const writer = this.writer;
    const startedAt = Date.now();
    for (let i = 0; i < count; i += 1) {
      await writer(tableName).insert({ label: 'concurrent' });
    }
    this.concurrentWriteDurationMs = Date.now() - startedAt;
  }
);

Then('the concurrent writer\'s insert completes in under {int} seconds', function (seconds) {
  assert.ok(
    this.concurrentWriteDurationMs < seconds * 1000,
    `concurrent writer's insert took ${this.concurrentWriteDurationMs}ms, expected under ${seconds * 1000}ms — it queued behind the burst writer's S3 uploads`
  );
});

Then('all {int} rows eventually appear in {string} once the burst writer finishes', async function (expectedCount, tableName) {
  await this.burstDone;
  const rows = await this.writer(tableName).select('*');
  assert.equal(rows.length, expectedCount);
});
