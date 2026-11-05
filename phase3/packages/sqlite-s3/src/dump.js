import { stat } from 'node:fs/promises';
import { restoreLocalDb } from './restore.js';

/**
 * Materialise the store's current state as a plain, single-file SQLite
 * database. This is the inverse of seedStoreFromSqliteFile and the store's
 * disaster-recovery path: without it there is no way to read the bucket's
 * contents outside a running Ghost.
 *
 * restoreLocalDb returns silently for an empty store (see restore.js:10-12,
 * where "no manifest and no segments" legitimately means "a fresh database").
 * That is right for a booting Ghost and wrong here — a dump that produces
 * nothing is a failure the caller must see.
 */
export async function dumpStoreToSqliteFile({ manifestStore, segmentStore, leaseStore, dbPath }) {
  const { manifest } = await manifestStore.read();
  const hasWalSegments = manifest?.walSegmentIds?.length > 0;
  if (!manifest || (!manifest.baseSegmentId && !hasWalSegments)) {
    throw new Error('refusing to dump: the store is empty (no manifest, or no segments)');
  }

  await restoreLocalDb({ manifest, manifestStore, segmentStore, leaseStore, dbPath });
  const { size } = await stat(dbPath);
  return { bytes: size };
}
