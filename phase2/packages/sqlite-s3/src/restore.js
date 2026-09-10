import { rm, writeFile } from 'node:fs/promises';
import { buildMergedFileBytes } from './merge.js';

export async function restoreLocalDb({ manifest, segmentStore, leaseStore, dbPath, leaseTtlMs = 5 * 60_000 }) {
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });

  const hasWalSegments = manifest && manifest.walSegmentIds && manifest.walSegmentIds.length > 0;
  if (!manifest || (!manifest.baseSegmentId && !hasWalSegments)) {
    return; // truly nothing to restore — a fresh database
  }

  // A concurrent checkpoint can reclaim segments this manifest references
  // the moment it wins its own CAS. Holding a lease for the duration of the
  // fetch-and-merge tells that checkpoint's reclamation step these ids are
  // still in use, so it defers deleting them.
  const lease = await leaseStore.acquire(manifest, { ttlMs: leaseTtlMs });
  try {
    const fileBytes = await buildMergedFileBytes({ manifest, segmentStore });
    await writeFile(dbPath, fileBytes);
  } finally {
    await lease.release();
  }
}
