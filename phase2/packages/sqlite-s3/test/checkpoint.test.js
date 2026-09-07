import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpointPolicy, performCheckpoint } from '../src/checkpoint.js';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { createManifestStore } from '../src/manifest.js';
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
  await manifestStore.write({ baseSegmentId: null, walSegmentIds: [], pageSize: 16 }, { expectedEtag: null });

  const result = await performCheckpoint({ manifestStore, segmentStore });
  assert.equal(result.checkpointed, false);
});

test('performCheckpoint merges wal segments into a new base and clears walSegmentIds', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
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

  const result = await performCheckpoint({ manifestStore, segmentStore });
  assert.equal(result.checkpointed, true);

  const { manifest } = await manifestStore.read();
  assert.deepEqual(manifest.walSegmentIds, []);
  assert.notEqual(manifest.baseSegmentId, baseSegmentId, 'must point at a NEW base segment');

  const newBase = await segmentStore.getSegment(manifest.baseSegmentId);
  assert.ok(newBase.bytes.every((b) => b === 0xff), 'new base reflects the merged wal segment');
});

test('performCheckpoint abandons silently on a manifest CAS conflict', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const realManifestStore = createManifestStore(store);
  const pageSize = 16;
  await realManifestStore.write(
    { baseSegmentId: null, walSegmentIds: [await segmentStore.putSegment(
      encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0x01) }]),
      { dbSizeAfterCommit: 1 }
    )], pageSize },
    { expectedEtag: null }
  );

  // Simulate another writer landing a segment between our read and our write:
  // read() returns the real (stale-by-the-time-we-write) manifest, but write()
  // always fails as if someone else already advanced the manifest.
  const { manifest: staleManifest, etag: staleEtag } = await realManifestStore.read();
  const conflictingManifestStore = {
    read: async () => ({ manifest: staleManifest, etag: staleEtag }),
    write: async () => {
      const err = new Error('manifest changed since last read');
      err.name = 'ManifestConflictError';
      err.current = await realManifestStore.read();
      throw err;
    },
  };

  const result = await performCheckpoint({ manifestStore: conflictingManifestStore, segmentStore });
  assert.equal(result.checkpointed, false);
});
