// Compacts the store: folds the write-ahead segments into a new base snapshot,
// then sweeps segments nothing references any more. Plain: it never loads Ghost.
import {
  createManifestStore, createSegmentStore, createLeaseStore, performCheckpoint, reclaimOrphanedSegments,
} from '@ghost-phase3/sqlite-s3';

export function createCheckpointHandler({ objectStore }) {
  const manifestStore = createManifestStore(objectStore);
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);
  return async function handler() {
    const started = Date.now();
    const checkpoint = await performCheckpoint({ manifestStore, segmentStore, leaseStore });
    const swept = await reclaimOrphanedSegments({ manifestStore, segmentStore, objectStore, leaseStore });
    const result = { checkpointed: checkpoint.checkpointed, scanned: swept.scanned, orphansDeleted: swept.deleted.length, ms: Date.now() - started };
    console.log(JSON.stringify({ checkpoint: result }));
    return result;
  };
}
