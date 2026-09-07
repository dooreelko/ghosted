import { writeSetFromFrames } from './wal.js';

const MAX_ATTEMPTS = 10;

function fullJitterDelay(attempt, baseMs = 50, capMs = 2000) {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.random() * exp;
}

export function createCommitter({ manifestStore, segmentStore, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  return {
    async commitWalDelta(payloadBytes, frames, pageSize) {
      const writeSet = writeSetFromFrames(frames);
      const dbSizeAfterCommit = frames[frames.length - 1]?.dbSizeAfterCommit ?? 0;
      let { manifest, etag } = await manifestStore.read();

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const segmentId = await segmentStore.putSegment(payloadBytes, { writeSet, dbSizeAfterCommit });
        const nextManifest = {
          baseSegmentId: manifest ? manifest.baseSegmentId : null,
          walSegmentIds: manifest ? [...manifest.walSegmentIds, segmentId] : [segmentId],
          pageSize: manifest?.pageSize ?? pageSize,
        };
        try {
          const result = await manifestStore.write(nextManifest, { expectedEtag: etag });
          return { segmentId, etag: result.etag };
        } catch (err) {
          if (err.name !== 'ManifestConflictError') throw err;

          const priorWalIds = manifest ? manifest.walSegmentIds : [];
          const latestManifest = err.current.manifest;
          const newSegmentIds = latestManifest.walSegmentIds.slice(priorWalIds.length);
          const theirWriteSets = await Promise.all(
            newSegmentIds.map(async (id) => (await segmentStore.getSegment(id)).meta.writeSet ?? [])
          );
          const theirPages = new Set(theirWriteSets.flat());
          const overlap = writeSet.some((page) => theirPages.has(page));

          manifest = latestManifest;
          etag = err.current.etag;

          if (overlap) {
            return { retryTransaction: true };
          }
          await sleep(fullJitterDelay(attempt));
        }
      }
      throw new Error('commit failed after max retries: conflicting writers');
    },
  };
}
