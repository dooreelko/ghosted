import { randomUUID } from 'node:crypto';

const LEASE_PREFIX = 'leases/';

export function createLeaseStore(objectStore) {
  async function writeLease(key, manifest, ttlMs, now) {
    const bytes = Buffer.from(JSON.stringify({ manifest, expiresAt: now + ttlMs }));
    await objectStore.put(key, bytes);
  }

  return {
    async acquire(manifest, { ttlMs, now = Date.now() }) {
      const key = `${LEASE_PREFIX}${randomUUID()}`;
      await writeLease(key, manifest, ttlMs, now);
      return {
        key,
        async refresh(refreshTtlMs, refreshNow = Date.now()) {
          await writeLease(key, manifest, refreshTtlMs, refreshNow);
        },
        async release() {
          await objectStore.delete(key);
        },
      };
    },

    async listActiveSegmentIds(now = Date.now()) {
      const keys = await objectStore.list(LEASE_PREFIX);
      const ids = new Set();
      for (const key of keys) {
        let lease;
        try {
          const { bytes } = await objectStore.get(key);
          lease = JSON.parse(bytes.toString('utf8'));
        } catch (err) {
          if (err.code === 'NotFound') continue; // released between list() and get()
          throw err;
        }
        if (lease.expiresAt <= now) continue;
        if (lease.manifest?.baseSegmentId) ids.add(lease.manifest.baseSegmentId);
        for (const id of lease.manifest?.walSegmentIds ?? []) ids.add(id);
      }
      return ids;
    },
  };
}
