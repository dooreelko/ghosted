import { writeSetFromFrames } from './wal.js';

const MAX_ATTEMPTS = 10;

export function fullJitterDelay(attempt, baseMs = 50, capMs = 2000) {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.random() * exp;
}

// `rebase: false` makes every lost compare-and-swap a required retry, even when the other
// writer's pages are disjoint. Disjoint pages are not enough to prove the two transactions
// independent: the caller's local file lacks the other writer's segments, so what it read
// (and any page it writes later) may be stale; a caller that can replay the whole unit of
// work (a request) wants that.
export function createCommitter({ manifestStore, segmentStore, rebase = true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  return {
    // `baseline` is the {manifest, etag} the caller's LOCAL db was actually
    // built from (its last restore, or its own previous successful commit)
    // -- never a fresh read taken here. Reading fresh right before the CAS
    // attempt would make the optimistic-concurrency check nearly a no-op:
    // it would almost always match what we just read, even though the
    // caller's local page image was captured against much older state, so
    // a conflicting writer's already-landed segment could go undetected
    // and get silently clobbered by this commit's stale page image.
    async commitWalDelta(payloadBytes, frames, pageSize, baseline) {
      const writeSet = writeSetFromFrames(frames);
      const dbSizeAfterCommit = frames[frames.length - 1]?.dbSizeAfterCommit ?? 0;
      let manifest = baseline.manifest;
      let etag = baseline.etag;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const segmentId = await segmentStore.putSegment(payloadBytes, { writeSet, dbSizeAfterCommit });
        const nextManifest = {
          baseSegmentId: manifest ? manifest.baseSegmentId : null,
          walSegmentIds: manifest ? [...manifest.walSegmentIds, segmentId] : [segmentId],
          pageSize: manifest?.pageSize ?? pageSize,
        };
        try {
          const result = await manifestStore.write(nextManifest, { expectedEtag: etag });
          return { segmentId, etag: result.etag, manifest: nextManifest };
        } catch (err) {
          if (err.name !== 'ManifestConflictError') throw err;

          if (!rebase) return { retryTransaction: true };
          const priorWalIds = manifest ? manifest.walSegmentIds : [];
          const priorBaseSegmentId = manifest ? manifest.baseSegmentId : null;
          const latestManifest = err.current.manifest;

          // Diff by id, not by position: a checkpoint can reset
          // walSegmentIds to [] and swap in a new baseSegmentId between our
          // snapshot and this CAS attempt, which makes a positional
          // slice()-based diff meaningless (it can land on a shorter/empty
          // array and silently conclude "no new segments").
          const priorSet = new Set(priorWalIds);
          const newSegmentIds = latestManifest.walSegmentIds.filter((id) => !priorSet.has(id));
          // If the base itself changed, some prior segments' write-sets are
          // no longer individually inspectable -- they've been folded into
          // the new base -- so we can no longer prove non-overlap. Treat
          // this as unrebasable regardless of what the (possibly
          // incomplete) page-level diff below finds.
          const baseChanged = latestManifest.baseSegmentId !== priorBaseSegmentId;

          const theirWriteSets = await Promise.all(
            newSegmentIds.map(async (id) => (await segmentStore.getSegment(id)).meta.writeSet ?? [])
          );
          const theirPages = new Set(theirWriteSets.flat());
          const overlap = writeSet.some((page) => theirPages.has(page));

          manifest = latestManifest;
          etag = err.current.etag;

          if (baseChanged || overlap) {
            return { retryTransaction: true };
          }
          await sleep(fullJitterDelay(attempt));
        }
      }
      throw new Error('commit failed after max retries: conflicting writers');
    },
  };
}
