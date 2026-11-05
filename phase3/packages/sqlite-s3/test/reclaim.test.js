import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { createManifestStore } from '../src/manifest.js';
import { createLeaseStore } from '../src/leases.js';
import { reclaimOrphanedSegments } from '../src/reclaim.js';

test('reclaimOrphanedSegments deletes only segments unreachable from the manifest and unprotected by a lease', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);

  const reachableBaseId = await segmentStore.putSegment(Buffer.from('reachable-base'));
  const reachableWalId = await segmentStore.putSegment(Buffer.from('reachable-wal'));
  await manifestStore.write(
    { baseSegmentId: reachableBaseId, walSegmentIds: [reachableWalId], pageSize: 16 },
    { expectedEtag: null }
  );

  const orphanId = await segmentStore.putSegment(Buffer.from('orphan'));
  const leasedOrphanId = await segmentStore.putSegment(Buffer.from('leased-orphan'));
  await leaseStore.acquire({ baseSegmentId: leasedOrphanId, walSegmentIds: [] }, { ttlMs: 3 * 60 * 60_000 });
  const expiredLeaseOrphanId = await segmentStore.putSegment(Buffer.from('expired-lease-orphan'));
  await leaseStore.acquire({ baseSegmentId: expiredLeaseOrphanId, walSegmentIds: [] }, { ttlMs: 1, now: 0 });

  const objectStore = store;
  const result = await reclaimOrphanedSegments({
    manifestStore,
    segmentStore,
    objectStore,
    leaseStore,
    now: Date.now() + 2 * 60 * 60_000,
  });

  assert.deepEqual(result.deleted.sort(), [orphanId, expiredLeaseOrphanId].sort());
  assert.equal(result.scanned, 5);

  await segmentStore.getSegment(reachableBaseId);
  await segmentStore.getSegment(reachableWalId);
  await segmentStore.getSegment(leasedOrphanId);
  await assert.rejects(() => segmentStore.getSegment(orphanId), (err) => err.code === 'NotFound');
  await assert.rejects(() => segmentStore.getSegment(expiredLeaseOrphanId), (err) => err.code === 'NotFound');
});

test('reclaimOrphanedSegments is a no-op on a store with nothing to reclaim', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
  const baseSegmentId = await segmentStore.putSegment(Buffer.from('base'));
  await manifestStore.write({ baseSegmentId, walSegmentIds: [], pageSize: 16 }, { expectedEtag: null });

  const result = await reclaimOrphanedSegments({
    manifestStore,
    segmentStore,
    objectStore: store,
    leaseStore,
    minAgeMs: 0,
  });
  assert.deepEqual(result.deleted, []);
  assert.equal(result.scanned, 1);
});

test('reclaimOrphanedSegments does not delete an unreachable segment younger than minAgeMs, but does once it ages past it', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);

  const baseSegmentId = await segmentStore.putSegment(Buffer.from('base'));
  await manifestStore.write({ baseSegmentId, walSegmentIds: [], pageSize: 16 }, { expectedEtag: null });

  const freshOrphanId = await segmentStore.putSegment(Buffer.from('fresh-orphan'));

  const immediateResult = await reclaimOrphanedSegments({ manifestStore, segmentStore, objectStore: store, leaseStore });
  assert.deepEqual(immediateResult.deleted, []);
  await segmentStore.getSegment(freshOrphanId);

  const laterResult = await reclaimOrphanedSegments({
    manifestStore,
    segmentStore,
    objectStore: store,
    leaseStore,
    now: Date.now() + 2 * 60 * 60_000,
  });
  assert.deepEqual(laterResult.deleted, [freshOrphanId]);
  await assert.rejects(() => segmentStore.getSegment(freshOrphanId), (err) => err.code === 'NotFound');
});

test('reclaimOrphanedSegments deletes an expired lease object but leaves an active lease alone', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);

  const baseSegmentId = await segmentStore.putSegment(Buffer.from('base'));
  await manifestStore.write({ baseSegmentId, walSegmentIds: [], pageSize: 16 }, { expectedEtag: null });

  const expiredLease = await leaseStore.acquire({ baseSegmentId, walSegmentIds: [] }, { ttlMs: 1, now: 0 });
  const activeLease = await leaseStore.acquire({ baseSegmentId, walSegmentIds: [] }, { ttlMs: 60_000, now: 0 });

  await reclaimOrphanedSegments({ manifestStore, segmentStore, objectStore: store, leaseStore, now: 1000, minAgeMs: 0 });

  await assert.rejects(() => store.get(expiredLease.key), (err) => err.code === 'NotFound');
  await store.get(activeLease.key);
});

test('reclaimOrphanedSegments with dryRun:true identifies orphans without deleting them', async () => {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);

  const baseSegmentId = await segmentStore.putSegment(Buffer.from('base'));
  await manifestStore.write({ baseSegmentId, walSegmentIds: [], pageSize: 16 }, { expectedEtag: null });

  const orphanId = await segmentStore.putSegment(Buffer.from('orphan'));

  const result = await reclaimOrphanedSegments({
    manifestStore,
    segmentStore,
    objectStore: store,
    leaseStore,
    minAgeMs: 0,
    dryRun: true,
  });

  assert.deepEqual(result.deleted, [orphanId]);
  assert.equal(result.scanned, 2);
  await segmentStore.getSegment(orphanId);
});
