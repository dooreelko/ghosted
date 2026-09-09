import { readFile } from 'node:fs/promises';

const SQLITE_MAGIC = 'SQLite format 3 ';

/**
 * The page size lives at byte offset 16 of the SQLite header as a big-endian
 * 16-bit value. A stored value of 1 means 65536, which does not fit in 16
 * bits — SQLite's own encoding trick, and the same one src/merge.js decodes.
 */
export function readPageSize(fileBytes) {
  if (fileBytes.length < 100) {
    throw new Error('not a SQLite database: header magic missing or file truncated');
  }
  const magic = fileBytes.subarray(0, 16).toString('latin1');
  // Accept both "SQLite format 3 " (with space) and "SQLite format 3\0" (with null byte)
  if (magic !== SQLITE_MAGIC && magic !== 'SQLite format 3\0') {
    throw new Error('not a SQLite database: header magic missing or file truncated');
  }
  const raw = fileBytes.readUInt16BE(16);
  return raw === 1 ? 65536 : raw;
}

/**
 * Turn a plain, single-file SQLite database into the initial state of an
 * S3-backed store: the whole file becomes the base segment, and the manifest
 * points at it with an empty WAL list — the same shape src/merge.js expects.
 *
 * The manifest is written with expectedEtag: null, which becomes an
 * If-None-Match: * conditional put. Seeding a store that already exists
 * therefore fails instead of destroying it. There is deliberately no force
 * option: emptying a store is a separate, explicit act.
 */
export async function seedStoreFromSqliteFile({ dbPath, manifestStore, segmentStore }) {
  const fileBytes = await readFile(dbPath);
  const pageSize = readPageSize(fileBytes);

  const { manifest: existing } = await manifestStore.read();
  if (existing) {
    throw new Error(
      'refusing to seed: this store is already seeded (root.json exists). ' +
        'Empty the bucket deliberately if you really mean to start over.'
    );
  }

  const baseSegmentId = await segmentStore.putSegment(fileBytes, { kind: 'base' });
  const { etag } = await manifestStore.write(
    { baseSegmentId, walSegmentIds: [], pageSize },
    { expectedEtag: null }
  );

  return { baseSegmentId, pageSize, etag, bytes: fileBytes.length };
}
