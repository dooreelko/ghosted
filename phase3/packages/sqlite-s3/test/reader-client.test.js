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
import { createLeaseStore } from '../src/leases.js';
import { SqliteS3Client } from '../src/knex-client.js';
import { ReaderClient } from '../src/reader-client.js';

async function tmpDbPath() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sqlite-s3-reader-test-'));
  return path.join(dir, 'app.db');
}

test('ReaderClient sees data the writer already committed to the same file', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const s3Config = {
    manifestStore: createManifestStore(store),
    segmentStore: createSegmentStore(store),
    leaseStore: createLeaseStore(store),
    checkpointPolicy: createCheckpointPolicy({ maxWalBytes: 10_000_000, maxIntervalMs: 3_600_000 }),
  };
  const writer = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: s3Config },
    useNullAsDefault: true,
  });
  try {
    await writer.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });
    await writer('widgets').insert({ name: 'gizmo' });

    const reader = knexFactory({
      client: ReaderClient,
      connection: { filename: dbPath },
      pool: { min: 1, max: 3 },
      useNullAsDefault: true,
    });
    try {
      const rows = await reader('widgets').select('*');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'gizmo');
    } finally {
      await reader.destroy();
    }
  } finally {
    await writer.destroy();
  }
});

test('ReaderClient rejects writes (query_only)', async () => {
  const dbPath = await tmpDbPath();
  const store = createInMemoryObjectStore();
  const writer = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: { manifestStore: createManifestStore(store), segmentStore: createSegmentStore(store), leaseStore: createLeaseStore(store), checkpointPolicy: createCheckpointPolicy({ maxWalBytes: 10_000_000, maxIntervalMs: 3_600_000 }) } },
    useNullAsDefault: true,
  });
  try {
    await writer.schema.createTable('widgets', (t) => t.increments('id'));
    const reader = knexFactory({ client: ReaderClient, connection: { filename: dbPath }, useNullAsDefault: true });
    try {
      await assert.rejects(() => reader('widgets').insert({}));
    } finally {
      await reader.destroy();
    }
  } finally {
    await writer.destroy();
  }
});

test('ReaderClient pool honors the configured max concurrent connections', async () => {
  const dbPath = await tmpDbPath();
  const reader = knexFactory({
    client: ReaderClient,
    connection: { filename: dbPath },
    pool: { min: 1, max: 3 },
    useNullAsDefault: true,
  });
  try {
    assert.equal(reader.client.pool.max, 3);
  } finally {
    await reader.destroy();
  }
});
