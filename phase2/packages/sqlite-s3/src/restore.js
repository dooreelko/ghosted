import { rm, writeFile } from 'node:fs/promises';
import { decodePageImages } from './page-images.js';

export async function restoreLocalDb({ manifest, segmentStore, dbPath }) {
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });

  const hasWalSegments = manifest && manifest.walSegmentIds && manifest.walSegmentIds.length > 0;
  if (!manifest || (!manifest.baseSegmentId && !hasWalSegments)) {
    return; // truly nothing to restore — a fresh database
  }

  let fileBytes = Buffer.alloc(0);
  if (manifest.baseSegmentId) {
    const base = await segmentStore.getSegment(manifest.baseSegmentId);
    fileBytes = Buffer.from(base.bytes);
  }

  const pageSize = manifest.pageSize;
  let finalPageCount = pageSize > 0 ? Math.floor(fileBytes.length / pageSize) : 0;

  for (const walSegmentId of manifest.walSegmentIds ?? []) {
    const seg = await segmentStore.getSegment(walSegmentId);
    const pages = decodePageImages(seg.bytes);
    for (const { pageNumber, bytes } of pages) {
      const endOffset = pageNumber * pageSize;
      if (endOffset > fileBytes.length) {
        const grown = Buffer.alloc(endOffset);
        fileBytes.copy(grown);
        fileBytes = grown;
      }
      bytes.copy(fileBytes, (pageNumber - 1) * pageSize);
    }
    if (seg.meta?.dbSizeAfterCommit) {
      finalPageCount = seg.meta.dbSizeAfterCommit;
    }
  }

  if (finalPageCount > 0) {
    fileBytes = fileBytes.subarray(0, finalPageCount * pageSize);
  }

  await writeFile(dbPath, fileBytes);
}
