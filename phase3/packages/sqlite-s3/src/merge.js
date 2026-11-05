import { decodePageImages } from './page-images.js';

export async function foldWalSegments({ fileBytes, finalPageCount, walSegmentIds, segmentStore, pageSize }) {
  let bytes = fileBytes;
  let pageCount = finalPageCount;

  for (const walSegmentId of walSegmentIds) {
    const seg = await segmentStore.getSegment(walSegmentId);
    const pages = decodePageImages(seg.bytes);
    for (const { pageNumber, bytes: pageBytes } of pages) {
      const endOffset = pageNumber * pageSize;
      if (endOffset > bytes.length) {
        const grown = Buffer.alloc(endOffset);
        bytes.copy(grown);
        bytes = grown;
      }
      pageBytes.copy(bytes, (pageNumber - 1) * pageSize);
    }
    if (seg.meta?.dbSizeAfterCommit) {
      pageCount = Math.max(pageCount, seg.meta.dbSizeAfterCommit);
    }
  }

  return { fileBytes: bytes, finalPageCount: pageCount };
}

export function truncateToPageCount(fileBytes, finalPageCount, pageSize) {
  if (finalPageCount > 0) {
    return fileBytes.subarray(0, finalPageCount * pageSize);
  }
  return fileBytes;
}

export async function buildMergedFileBytes({ manifest, segmentStore }) {
  const hasWalSegments = manifest && manifest.walSegmentIds && manifest.walSegmentIds.length > 0;
  if (!manifest || (!manifest.baseSegmentId && !hasWalSegments)) {
    return Buffer.alloc(0);
  }

  if (hasWalSegments && !(Number.isInteger(manifest.pageSize) && manifest.pageSize > 0)) {
    throw new Error(
      `buildMergedFileBytes: manifest.pageSize is missing or invalid (${manifest.pageSize}) but wal segments exist — cannot compute page offsets`
    );
  }

  let fileBytes = Buffer.alloc(0);
  if (manifest.baseSegmentId) {
    const base = await segmentStore.getSegment(manifest.baseSegmentId);
    fileBytes = Buffer.from(base.bytes);

    if (manifest.pageSize && fileBytes.length >= 18) {
      const rawPageSize = fileBytes.readUInt16BE(16);
      const basePageSize = rawPageSize === 1 ? 65536 : rawPageSize;
      if (basePageSize !== manifest.pageSize) {
        throw new Error(
          `buildMergedFileBytes: manifest.pageSize (${manifest.pageSize}) does not match the base segment's own page size (${basePageSize})`
        );
      }
    }
  }

  const pageSize = manifest.pageSize;
  const initialPageCount = pageSize > 0 ? Math.floor(fileBytes.length / pageSize) : 0;

  const { fileBytes: folded, finalPageCount } = await foldWalSegments({
    fileBytes,
    finalPageCount: initialPageCount,
    walSegmentIds: manifest.walSegmentIds ?? [],
    segmentStore,
    pageSize,
  });

  return truncateToPageCount(folded, finalPageCount, pageSize);
}
