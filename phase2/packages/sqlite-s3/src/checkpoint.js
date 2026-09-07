import { buildMergedFileBytes } from './merge.js';

export function createCheckpointPolicy({ maxWalBytes, maxIntervalMs, now = () => Date.now() }) {
  let bytesSinceCheckpoint = 0;
  let lastCheckpointAt = now();
  let dirty = false;

  return {
    recordSegment(byteLength) {
      bytesSinceCheckpoint += byteLength;
      dirty = true;
    },
    shouldCheckpoint() {
      if (bytesSinceCheckpoint >= maxWalBytes) return true;
      if (dirty && now() - lastCheckpointAt >= maxIntervalMs) return true;
      return false;
    },
    recordCheckpoint() {
      bytesSinceCheckpoint = 0;
      lastCheckpointAt = now();
      dirty = false;
    },
  };
}

export async function performCheckpoint({ manifestStore, segmentStore }) {
  const { manifest, etag } = await manifestStore.read();
  if (!manifest || !manifest.walSegmentIds || manifest.walSegmentIds.length === 0) {
    return { checkpointed: false };
  }

  const mergedBytes = await buildMergedFileBytes({ manifest, segmentStore });
  const newBaseId = await segmentStore.putSegment(mergedBytes);
  const nextManifest = {
    baseSegmentId: newBaseId,
    walSegmentIds: [],
    pageSize: manifest.pageSize,
  };

  try {
    await manifestStore.write(nextManifest, { expectedEtag: etag });
    return { checkpointed: true };
  } catch (err) {
    if (err.name !== 'ManifestConflictError') throw err;
    // Another writer landed a segment mid-merge — abandon this attempt.
    // Best-effort: the trigger policy fires again later.
    return { checkpointed: false };
  }
}
