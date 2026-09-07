import { writeFile, appendFile, rm } from 'node:fs/promises';
import Database from 'better-sqlite3';

export async function restoreLocalDb({ manifest, segmentStore, dbPath }) {
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });

  const hasWalSegments = manifest && manifest.walSegmentIds && manifest.walSegmentIds.length > 0;
  if (!manifest || (!manifest.baseSegmentId && !hasWalSegments)) {
    return; // truly nothing to restore — a fresh database
  }

  if (manifest.baseSegmentId) {
    const base = await segmentStore.getSegment(manifest.baseSegmentId);
    await writeFile(dbPath, base.bytes);
  } else {
    // No base snapshot has ever been taken (no checkpoint has run yet), but
    // the manifest's walSegmentIds is the single global commit history —
    // shared across every writer via the CAS-based manifest — so replaying
    // it in full onto a freshly bootstrapped, valid, empty SQLite database
    // reconstructs the same state regardless of which writer is restarting.
    //
    // The bootstrap must explicitly switch to WAL journal mode before
    // closing: SQLite records the journal mode in the main file's header
    // (the page-1 file-format-version bytes), and only consults a sibling
    // `-wal` file when that header declares WAL mode. A plain
    // `new Database(dbPath).close()` with no writes leaves a 0-byte file
    // (rollback-journal mode, header absent) — SQLite then ignores the
    // `-wal` file entirely and the replayed segments are silently lost.
    const bootstrap = new Database(dbPath);
    bootstrap.pragma('journal_mode = WAL');
    bootstrap.close();
  }

  for (const walSegmentId of manifest.walSegmentIds ?? []) {
    const seg = await segmentStore.getSegment(walSegmentId);
    await appendFile(`${dbPath}-wal`, seg.bytes);
  }
}
