const SEGMENT_PREFIX = 'segments/';
const SEGMENT_SUFFIX = '.seg';
const LEASE_PREFIX = 'leases/';
const DEFAULT_MIN_AGE_MS = 60 * 60_000;

function segmentIdFromKey(key) {
  if (!key.startsWith(SEGMENT_PREFIX) || !key.endsWith(SEGMENT_SUFFIX)) return null;
  return key.slice(SEGMENT_PREFIX.length, key.length - SEGMENT_SUFFIX.length);
}

async function reclaimExpiredLeases({ objectStore, now }) {
  const leaseKeys = await objectStore.list(LEASE_PREFIX);
  for (const key of leaseKeys) {
    try {
      const { bytes } = await objectStore.get(key);
      const lease = JSON.parse(bytes.toString('utf8'));
      if (lease.expiresAt <= now) await objectStore.delete(key);
    } catch (err) {
      if (err.code !== 'NotFound') throw err;
    }
  }
}

export async function reclaimOrphanedSegments({
  manifestStore,
  segmentStore,
  objectStore,
  leaseStore,
  now = Date.now(),
  minAgeMs = DEFAULT_MIN_AGE_MS,
  dryRun = false,
}) {
  await reclaimExpiredLeases({ objectStore, now });

  const allSegments = await objectStore.listWithMetadata(SEGMENT_PREFIX);
  const { manifest } = await manifestStore.read();
  const reachable = new Set();
  if (manifest?.baseSegmentId) reachable.add(manifest.baseSegmentId);
  for (const id of manifest?.walSegmentIds ?? []) reachable.add(id);

  const protectedIds = await leaseStore.listActiveSegmentIds(now);

  const orphaned = [];
  for (const { key, lastModified } of allSegments) {
    const id = segmentIdFromKey(key);
    if (id === null) continue;
    if (reachable.has(id) || protectedIds.has(id)) continue;
    if (now - lastModified < minAgeMs) continue;
    orphaned.push(id);
  }

  if (!dryRun) {
    await Promise.all(orphaned.map((id) => segmentStore.deleteSegment(id)));
  }

  return { scanned: allSegments.length, deleted: orphaned };
}
