import BetterSQLite3Client from 'knex/lib/dialects/better-sqlite3/index.js';

// A plain, read-only view onto the SAME on-disk file SqliteS3Client's
// writer maintains. Never restores from S3 (the writer already keeps the
// file current, and restoreLocalDb's rewrite is atomic via rename — see
// restore.js — so opening the file here concurrently with a writer-side
// restore is safe: this always sees either the old complete file or the
// new complete file). Never participates in commit-capture — read-only
// connections produce no WAL growth of their own to ship.
export class ReaderClient extends BetterSQLite3Client {
  constructor(config) {
    // Pool size is caller-controlled (unlike the writer, which MUST stay
    // pinned to one connection) -- SQLite's WAL mode natively supports many
    // concurrent readers alongside the one writer.
    super(config);
  }

  async acquireRawConnection() {
    const connection = await super.acquireRawConnection();
    connection.pragma('query_only = ON');
    return connection;
  }
}
