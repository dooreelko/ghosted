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
  await leaseStore.acquire({ baseSegmentId: leasedOrphanId, walSegmentIds: [] }, { ttlMs: 60_000 });
  const expiredLeaseOrphanId = await segmentStore.putSegment(Buffer.from('expired-lease-orphan'));
  await leaseStore.acquire({ baseSegmentId: expiredLeaseOrphanId, walSegmentIds: [] }, { ttlMs: 1, now: 0 });

  const objectStore = store;
  const result = await reclaimOrphanedSegments({ manifestStore, segmentStore, objectStore, leaseStore, now: 1000 });

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

  const result = await reclaimOrphanedSegments({ manifestStore, segmentStore, objectStore: store, leaseStore });
  assert.deepEqual(result.deleted, []);
  assert.equal(result.scanned, 1);
});
