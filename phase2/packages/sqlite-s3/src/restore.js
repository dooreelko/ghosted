import { rm, writeFile, rename } from 'node:fs/promises';
import { buildMergedFileBytes } from './merge.js';

const DEFAULT_MAX_ATTEMPTS = 3;

export async function restoreLocalDb({
  manifest,
  manifestStore,
  segmentStore,
  leaseStore,
  dbPath,
  leaseTtlMs = 5 * 60_000,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });

  let currentManifest = manifest;
  const hasWalSegments = currentManifest && currentManifest.walSegmentIds && currentManifest.walSegmentIds.length > 0;
  if (!currentManifest || (!currentManifest.baseSegmentId && !hasWalSegments)) {
    // truly nothing to restore — a fresh database. clear any stale file on disk.
    await rm(dbPath, { force: true });
    return { attempts: 0, durationMs: 0 };
  }

  const startedAt = Date.now();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // A concurrent checkpoint can reclaim segments this manifest references
    // the moment it wins its own CAS. Holding a lease for the duration of the
    // fetch-and-merge tells that checkpoint's reclamation step these ids are
    // still in use, so it defers deleting them. The manifest was read by our
    // caller before this lease existed, though, so a checkpoint's reclaim
    // decision can already be in flight by the time we acquire it -- if a
    // fetch below hits exactly that window, re-read the manifest and retry
    // against whatever's current now.
    const lease = await leaseStore.acquire(currentManifest, { ttlMs: leaseTtlMs });
    try {
      const fileBytes = await buildMergedFileBytes({ manifest: currentManifest, segmentStore });
      const tmpPath = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(tmpPath, fileBytes);
        await rename(tmpPath, dbPath); // atomic on the same filesystem — readers see the old or new file, never a torn one
      } catch (writeErr) {
        // best-effort cleanup of temp file on write/rename failure (e.g., disk full)
        await rm(tmpPath, { force: true }).catch(() => {});
        throw writeErr;
      }
      return { attempts: attempt + 1, durationMs: Date.now() - startedAt };
    } catch (err) {
      if (err.code !== 'NotFound' || attempt === maxAttempts - 1) throw err;
      const { manifest: freshManifest } = await manifestStore.read();
      currentManifest = freshManifest;
    } finally {
      await lease.release();
    }
  }
}
