const SEGMENT_PREFIX = 'segments/';
const SEGMENT_SUFFIX = '.seg';

function segmentIdFromKey(key) {
  return key.slice(SEGMENT_PREFIX.length, key.length - SEGMENT_SUFFIX.length);
}

export async function reclaimOrphanedSegments({ manifestStore, segmentStore, objectStore, leaseStore, now = Date.now() }) {
  const { manifest } = await manifestStore.read();
  const reachable = new Set();
  if (manifest?.baseSegmentId) reachable.add(manifest.baseSegmentId);
  for (const id of manifest?.walSegmentIds ?? []) reachable.add(id);

  const protectedIds = await leaseStore.listActiveSegmentIds(now);
  const allKeys = await objectStore.list(SEGMENT_PREFIX);

  const deleted = [];
  for (const key of allKeys) {
    const id = segmentIdFromKey(key);
    if (reachable.has(id) || protectedIds.has(id)) continue;
    await segmentStore.deleteSegment(id);
    deleted.push(id);
  }

  return { scanned: allKeys.length, deleted };
}
