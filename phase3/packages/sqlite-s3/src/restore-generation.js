// Tracks, per on-disk db path, how many times restoreLocalDb has
// successfully rewritten that file's inode via its atomic write-to-temp +
// rename (see restore.js / Task 3). This lives in its own module (rather
// than inside knex-client.js, which already imports reader-client.js) so
// both knex-client.js (the writer, which bumps it) and reader-client.js
// (the reader pool, which reads it to invalidate stale connections) can
// import it without a circular dependency.
//
// Keyed per db path, not a single process-wide scalar, for the same reason
// pendingShips in knex-client.js is: more than one independent
// SqliteS3Client pool (and therefore more than one independent ReaderClient
// pool) can be alive in the same process against different db files.
const generations = new Map(); // dbPath -> integer, starts effectively 0

export function bumpRestoreGeneration(dbPath) {
  generations.set(dbPath, (generations.get(dbPath) ?? 0) + 1);
}

export function currentRestoreGeneration(dbPath) {
  return generations.get(dbPath) ?? 0;
}
