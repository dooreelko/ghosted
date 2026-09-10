import { foldWalSegments, truncateToPageCount } from './merge.js';

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

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

export async function performCheckpoint({
  manifestStore,
  segmentStore,
  leaseStore,
  maxRetries = DEFAULT_MAX_RETRIES,
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  now = () => Date.now(),
  onBeforeWrite = async () => {},
}) {
  const { manifest: startManifest, etag: startEtag } = await manifestStore.read();
  if (!startManifest || !startManifest.walSegmentIds || startManifest.walSegmentIds.length === 0) {
    return { checkpointed: false };
  }

  let baseManifest = startManifest;
  let baseEtag = startEtag;
  let fileBytes = Buffer.alloc(0);
  let finalPageCount = 0;
  let foldedWalIds = [];

  if (baseManifest.baseSegmentId) {
    const base = await segmentStore.getSegment(baseManifest.baseSegmentId);
    fileBytes = Buffer.from(base.bytes);
    finalPageCount = baseManifest.pageSize > 0 ? Math.floor(fileBytes.length / baseManifest.pageSize) : 0;
  }

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const priorBaseSegmentId = baseManifest.baseSegmentId;
    const pending = baseManifest.walSegmentIds.filter((id) => !foldedWalIds.includes(id));

    ({ fileBytes, finalPageCount } = await foldWalSegments({
      fileBytes,
      finalPageCount,
      walSegmentIds: pending,
      segmentStore,
      pageSize: baseManifest.pageSize,
    }));
    foldedWalIds = [...foldedWalIds, ...pending];

    const mergedBytes = truncateToPageCount(fileBytes, finalPageCount, baseManifest.pageSize);
    const newBaseId = await segmentStore.putSegment(mergedBytes);
    const nextManifest = {
      baseSegmentId: newBaseId,
      walSegmentIds: [],
      pageSize: baseManifest.pageSize,
    };

    await onBeforeWrite({ attempt });

    try {
      await manifestStore.write(nextManifest, { expectedEtag: baseEtag });
      await reclaimSuperseded({
        leaseStore,
        segmentStore,
        candidateIds: [...(priorBaseSegmentId ? [priorBaseSegmentId] : []), ...foldedWalIds],
        now: now(),
      });
      return { checkpointed: true };
    } catch (err) {
      if (err.name !== 'ManifestConflictError') throw err;
      // This attempt lost the race -- its merged base must not leak.
      await segmentStore.deleteSegment(newBaseId);

      const latestManifest = err.current.manifest;
      if (latestManifest.baseSegmentId !== baseManifest.baseSegmentId) {
        // A DIFFERENT checkpoint won concurrently (not just a new commit) --
        // our merged bytes are built on a base that's no longer current.
        // Restart the merge from the new base rather than folding onto
        // stale bytes.
        fileBytes = Buffer.alloc(0);
        finalPageCount = 0;
        foldedWalIds = [];
        if (latestManifest.baseSegmentId) {
          const base = await segmentStore.getSegment(latestManifest.baseSegmentId);
          fileBytes = Buffer.from(base.bytes);
          finalPageCount = latestManifest.pageSize > 0
            ? Math.floor(fileBytes.length / latestManifest.pageSize)
            : 0;
        }
      }
      baseManifest = latestManifest;
      baseEtag = err.current.etag;
    }
  }

  return { checkpointed: false };
}

async function reclaimSuperseded({ leaseStore, segmentStore, candidateIds, now }) {
  if (candidateIds.length === 0) return;
  const protectedIds = await leaseStore.listActiveSegmentIds(now);
  const safeToDelete = candidateIds.filter((id) => !protectedIds.has(id));
  await Promise.all(safeToDelete.map((id) => segmentStore.deleteSegment(id)));
}
