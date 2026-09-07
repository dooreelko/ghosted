import { writeFile, appendFile, rm } from 'node:fs/promises';

export async function restoreLocalDb({ manifest, segmentStore, dbPath }) {
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });

  if (!manifest || !manifest.baseSegmentId) {
    return; // no base snapshot yet — a fresh database, nothing to restore
  }

  const base = await segmentStore.getSegment(manifest.baseSegmentId);
  await writeFile(dbPath, base.bytes);

  for (const walSegmentId of manifest.walSegmentIds) {
    const seg = await segmentStore.getSegment(walSegmentId);
    await appendFile(`${dbPath}-wal`, seg.bytes);
  }
}
