import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createLeaseStore } from '../src/leases.js';

test('a fresh lease reports its manifest\'s segment ids as active', async () => {
  const leaseStore = createLeaseStore(createInMemoryObjectStore());
  const manifest = { baseSegmentId: 'base-1', walSegmentIds: ['wal-1', 'wal-2'] };
  await leaseStore.acquire(manifest, { ttlMs: 60_000, now: 0 });
  const active = await leaseStore.listActiveSegmentIds(0);
  assert.deepEqual([...active].sort(), ['base-1', 'wal-1', 'wal-2']);
});

test('a lease past its TTL is excluded', async () => {
  const leaseStore = createLeaseStore(createInMemoryObjectStore());
  const manifest = { baseSegmentId: 'base-1', walSegmentIds: [] };
  await leaseStore.acquire(manifest, { ttlMs: 1000, now: 0 });
  const active = await leaseStore.listActiveSegmentIds(1001);
  assert.equal(active.size, 0);
});

test('release removes the lease so its segments no longer show as active', async () => {
  const leaseStore = createLeaseStore(createInMemoryObjectStore());
  const manifest = { baseSegmentId: 'base-1', walSegmentIds: [] };
  const lease = await leaseStore.acquire(manifest, { ttlMs: 60_000, now: 0 });
  await lease.release();
  const active = await leaseStore.listActiveSegmentIds(0);
  assert.equal(active.size, 0);
});

test('refresh extends the lease past its original expiry', async () => {
  const leaseStore = createLeaseStore(createInMemoryObjectStore());
  const manifest = { baseSegmentId: 'base-1', walSegmentIds: [] };
  const lease = await leaseStore.acquire(manifest, { ttlMs: 1000, now: 0 });
  await lease.refresh(1000, 900);
  const active = await leaseStore.listActiveSegmentIds(1500);
  assert.equal(active.size, 1);
});

test('listActiveSegmentIds tolerates a lease deleted between listing and reading it', async () => {
  const store = createInMemoryObjectStore();
  const leaseStore = createLeaseStore(store);
  const manifest = { baseSegmentId: 'base-1', walSegmentIds: [] };
  const lease = await leaseStore.acquire(manifest, { ttlMs: 60_000, now: 0 });
  const realGet = store.get.bind(store);
  store.get = async (key) => {
    if (key === lease.key) {
      const err = new Error('gone');
      err.code = 'NotFound';
      throw err;
    }
    return realGet(key);
  };
  const active = await leaseStore.listActiveSegmentIds(0);
  assert.equal(active.size, 0);
});
