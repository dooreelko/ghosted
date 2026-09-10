import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpointPolicy, performCheckpoint } from '../src/checkpoint.js';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { createManifestStore } from '../src/manifest.js';
import { createLeaseStore } from '../src/leases.js';
import { createCommitter } from '../src/commit.js';
import { encodePageImages } from '../src/page-images.js';

test('no checkpoint needed with no activity', () => {
  const policy = createCheckpointPolicy({ maxWalBytes: 1000, maxIntervalMs: 60_000 });
  assert.equal(policy.shouldCheckpoint(), false);
});

test('size-triggered: checkpoint once accumulated bytes cross the threshold', () => {
  const policy = createCheckpointPolicy({ maxWalBytes: 100, maxIntervalMs: 60_000 });
  policy.recordSegment(60);
  assert.equal(policy.shouldCheckpoint(), false);
  policy.recordSegment(50);
  assert.equal(policy.shouldCheckpoint(), true);
});

test('recordCheckpoint resets the size counter', () => {
  const policy = createCheckpointPolicy({ maxWalBytes: 100, maxIntervalMs: 60_000 });
  policy.recordSegment(150);
  assert.equal(policy.shouldCheckpoint(), true);
  policy.recordCheckpoint();
  assert.equal(policy.shouldCheckpoint(), false);
});

test('time-triggered: checkpoint after the interval, but only if something changed', () => {
  let clock = 0;
  const policy = createCheckpointPolicy({ maxWalBytes: 1_000_000, maxIntervalMs: 1000, now: () => clock });
  clock = 2000;
  assert.equal(policy.shouldCheckpoint(), false, 'idle period must not trigger a no-op checkpoint');
  policy.recordSegment(1);
  assert.equal(policy.shouldCheckpoint(), true);
});

test('time-triggered checkpoint is not re-armed until the interval passes again', () => {
  let clock = 0;
  const policy = createCheckpointPolicy({ maxWalBytes: 1_000_000, maxIntervalMs: 1000, now: () => clock });
  policy.recordSegment(1);
  clock = 1500;
  assert.equal(policy.shouldCheckpoint(), true);
  policy.recordCheckpoint();
  policy.recordSegment(1);
  clock = 1600;
  assert.equal(policy.shouldCheckpoint(), false);
  clock = 2600;
  assert.equal(policy.shouldCheckpoint(), true);
});

test('performCheckpoint does nothing when there are no wal segments to merge', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
  await manifestStore.write({ baseSegmentId: null, walSegmentIds: [], pageSize: 16 }, { expectedEtag: null });

  const result = await performCheckpoint({ manifestStore, segmentStore, leaseStore });
  assert.equal(result.checkpointed, false);
});

test('performCheckpoint merges wal segments into a new base, clears walSegmentIds, and reclaims the old base + wal segment', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
  const pageSize = 16;
  const baseBytes = Buffer.alloc(pageSize, 0x00);
  const baseSegmentId = await segmentStore.putSegment(baseBytes);
  const walSegmentId = await segmentStore.putSegment(
    encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0xff) }]),
    { dbSizeAfterCommit: 1 }
  );
  await manifestStore.write(
    { baseSegmentId, walSegmentIds: [walSegmentId], pageSize },
    { expectedEtag: null }
  );

  const result = await performCheckpoint({ manifestStore, segmentStore, leaseStore });
  assert.equal(result.checkpointed, true);

  const { manifest } = await manifestStore.read();
  assert.deepEqual(manifest.walSegmentIds, []);
  assert.notEqual(manifest.baseSegmentId, baseSegmentId, 'must point at a NEW base segment');

  const newBase = await segmentStore.getSegment(manifest.baseSegmentId);
  assert.ok(newBase.bytes.every((b) => b === 0xff), 'new base reflects the merged wal segment');

  await assert.rejects(() => segmentStore.getSegment(baseSegmentId), (err) => err.code === 'NotFound');
  await assert.rejects(() => segmentStore.getSegment(walSegmentId), (err) => err.code === 'NotFound');
});

test('performCheckpoint does not reclaim segments a live reader lease still references', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
  const pageSize = 16;
  const baseSegmentId = await segmentStore.putSegment(Buffer.alloc(pageSize, 0x00));
  const walSegmentId = await segmentStore.putSegment(
    encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0xff) }]),
    { dbSizeAfterCommit: 1 }
  );
  await manifestStore.write(
    { baseSegmentId, walSegmentIds: [walSegmentId], pageSize },
    { expectedEtag: null }
  );
  const { manifest: manifestBeingRestored } = await manifestStore.read();
  await leaseStore.acquire(manifestBeingRestored, { ttlMs: 60_000 });

  const result = await performCheckpoint({ manifestStore, segmentStore, leaseStore });
  assert.equal(result.checkpointed, true);

  const oldBase = await segmentStore.getSegment(baseSegmentId);
  assert.ok(oldBase, 'the old base must survive while a lease references it');
  const oldWal = await segmentStore.getSegment(walSegmentId);
  assert.ok(oldWal, 'the old wal segment must survive while a lease references it');
});

test('performCheckpoint retries and abandons after maxRetries under a permanent CAS conflict, leaking nothing', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const realManifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
  const pageSize = 16;
  await realManifestStore.write(
    { baseSegmentId: null, walSegmentIds: [await segmentStore.putSegment(
      encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0x01) }]),
      { dbSizeAfterCommit: 1 }
    )], pageSize },
    { expectedEtag: null }
  );

  // A manifestStore whose write() ALWAYS reports a conflict against the real,
  // unchanging manifest -- simulating a competitor that never actually lands
  // (so no amount of incremental folding can ever converge), to exercise the
  // retry cap and the delete-on-abandon path for every attempt.
  const conflictingManifestStore = {
    read: () => realManifestStore.read(),
    write: async () => {
      const err = new Error('manifest changed since last read');
      err.name = 'ManifestConflictError';
      err.current = await realManifestStore.read();
      throw err;
    },
  };

  const result = await performCheckpoint({
    manifestStore: conflictingManifestStore,
    segmentStore,
    leaseStore,
    maxRetries: 3,
  });
  assert.equal(result.checkpointed, false);

  const remaining = await store.list('segments/');
  assert.equal(remaining.length, 1, 'only the original wal segment may remain -- every abandoned attempt\'s base must be deleted');
});

test('performCheckpoint deletes its merged base and rethrows on a non-conflict manifestStore.write error', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const realManifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
  const pageSize = 16;
  const walSegmentId = await segmentStore.putSegment(
    encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0x01) }]),
    { dbSizeAfterCommit: 1 }
  );
  await realManifestStore.write(
    { baseSegmentId: null, walSegmentIds: [walSegmentId], pageSize },
    { expectedEtag: null }
  );

  const boom = new Error('transient network error');
  const flakyManifestStore = {
    read: () => realManifestStore.read(),
    write: async () => {
      throw boom;
    },
  };

  await assert.rejects(
    () => performCheckpoint({ manifestStore: flakyManifestStore, segmentStore, leaseStore }),
    (err) => err === boom
  );

  const remaining = await store.list('segments/');
  assert.equal(remaining.length, 1, 'only the original wal segment may remain -- the abandoned merged base must be deleted before rethrow');
});

test('performCheckpoint converges under a real commit landing mid-checkpoint, by folding it in on retry (race repro)', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
  const committer = createCommitter({ manifestStore, segmentStore });
  const pageSize = 16;

  const baseSegmentId = await segmentStore.putSegment(Buffer.alloc(pageSize, 0x00));
  const walSegmentId = await segmentStore.putSegment(
    encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0x11) }]),
    { dbSizeAfterCommit: 1 }
  );
  await manifestStore.write(
    { baseSegmentId, walSegmentIds: [walSegmentId], pageSize },
    { expectedEtag: null }
  );

  let landed = false;
  const result = await performCheckpoint({
    manifestStore,
    segmentStore,
    leaseStore,
    onBeforeWrite: async ({ attempt }) => {
      if (attempt !== 0 || landed) return;
      landed = true;
      // The exact production race: a real competing commit lands after this
      // checkpoint attempt has already built its merge, but before it wins
      // the manifest CAS.
      const baseline = await manifestStore.read();
      await committer.commitWalDelta(
        encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0x22) }]),
        [{ pageNumber: 1, dbSizeAfterCommit: 1 }],
        pageSize,
        baseline
      );
    },
  });

  assert.equal(result.checkpointed, true);
  const { manifest } = await manifestStore.read();
  assert.deepEqual(manifest.walSegmentIds, [], 'the retry must fold the racing commit in, not just lose to it');

  const newBase = await segmentStore.getSegment(manifest.baseSegmentId);
  assert.equal(newBase.bytes[0], 0x22, 'the racing commit\'s page must be present in the winning base');

  const remaining = await store.list('segments/');
  assert.equal(remaining.length, 1, 'the old base, old wal segment, the racing commit\'s wal segment, and the abandoned first-attempt base must all be gone except the winning base');
});
