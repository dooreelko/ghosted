import { rm, writeFile } from 'node:fs/promises';
import { buildMergedFileBytes } from './merge.js';

export async function restoreLocalDb({ manifest, segmentStore, dbPath }) {
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });

  const hasWalSegments = manifest && manifest.walSegmentIds && manifest.walSegmentIds.length > 0;
  if (!manifest || (!manifest.baseSegmentId && !hasWalSegments)) {
    return; // truly nothing to restore — a fresh database
  }

  const fileBytes = await buildMergedFileBytes({ manifest, segmentStore });
  await writeFile(dbPath, fileBytes);
}
