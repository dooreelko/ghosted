import BetterSQLite3Client from 'knex/lib/dialects/better-sqlite3/index.js';
import { currentRestoreGeneration } from './restore-generation.js';

// A plain, read-only view onto the SAME on-disk file SqliteS3Client's
// writer maintains. Never restores from S3 (the writer already keeps the
// file current, and restoreLocalDb's rewrite is atomic via rename — see
// restore.js — so opening the file here concurrently with a writer-side
// restore is safe: this always sees either the old complete file or the
// new complete file). Never participates in commit-capture — read-only
// connections produce no WAL growth of their own to ship.
//
// restoreLocalDb's atomicity is a write-to-temp-then-RENAME, which swaps the
// directory entry to a brand-new inode -- it does not touch the inode any
// already-open fd still points at. A reader connection opened before a
// restore keeps reading the OLD (now-unlinked) inode forever unless
// something forces it to reopen. This happens on every writer
// acquireRawConnection() call, including ordinary reconnects after a
// disposed connection (e.g. any S3 CAS conflict) -- not a rare event -- and
// pool connections pinned at `min` are never reaped/recreated on their own.
// validateConnection below is tarn's hook for exactly this: it runs before
// tarn hands out ANY pooled connection (including ones sitting at `min`),
// and returning false makes tarn destroy and recreate it before the query
// that triggered the acquire runs. Each connection is stamped with the
// restore generation current AT THE TIME IT WAS OPENED; once the writer's
// generation counter (bumped by SqliteS3Client.acquireRawConnection after
// every successful restore) moves past that, the stamped connection is
// stale and gets replaced on its next acquire.
export class ReaderClient extends BetterSQLite3Client {
  constructor(config) {
    // Pool size is caller-controlled (unlike the writer, which MUST stay
    // pinned to one connection) -- SQLite's WAL mode natively supports many
    // concurrent readers alongside the one writer. Only ensure
    // acquireTimeoutMillis has a default (same fail-fast rationale as the
    // writer's own pinned pool config in knex-client.js) -- everything else
    // in `config.pool` (notably `min`/`max`, already set by SqliteS3Client's
    // constructor) passes through untouched.
    super({
      ...config,
      pool: { ...config.pool, acquireTimeoutMillis: config.pool?.acquireTimeoutMillis ?? config.acquireTimeoutMillis ?? 15000 },
    });
  }

  async acquireRawConnection() {
    const connection = await super.acquireRawConnection();
    connection.pragma('query_only = ON');
    connection.__sqliteS3ReaderGeneration = currentRestoreGeneration(this.connectionSettings.filename);
    return connection;
  }

  // Note: this closes the window between restores, not the instant of one.
  // A read already in flight against a connection at the moment a restore
  // renames the file out from under it can still return pre-restore rows --
  // nothing coordinates a reader mid-query against a concurrent restore.
  // That window is accepted as-is (see the same note in knex-client.js's
  // acquireRawConnection); this only guarantees a connection is fresh as of
  // whenever it's newly handed out of the pool.
  validateConnection(connection) {
    return connection.__sqliteS3ReaderGeneration === currentRestoreGeneration(this.connectionSettings.filename);
  }
}
