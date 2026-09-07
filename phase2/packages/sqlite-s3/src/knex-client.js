// Verified against knex@3.3.0 — adjust this import if it stops resolving.
import BetterSQLite3Client from 'knex/lib/dialects/better-sqlite3/index.js';
import { statSync, readSync, openSync, closeSync } from 'node:fs';
import { restoreLocalDb } from './restore.js';
import { createCommitter } from './commit.js';
import { parseWalHeader, parseFrames } from './wal.js';

export class SqliteS3Client extends BetterSQLite3Client {
  constructor(config) {
    super(config);
    this._s3 = config.connection.s3;
    this._lastWalOffset = 0;
    this._pageSize = null;
  }

  async acquireRawConnection() {
    const { manifest } = await this._s3.manifestStore.read();
    this._manifest = manifest;
    await restoreLocalDb({
      manifest,
      segmentStore: this._s3.segmentStore,
      dbPath: this.connectionSettings.filename,
    });
    this._lastWalOffset = 0;
    this._pageSize = null;
    const connection = await super.acquireRawConnection();
    // Commit capture reads deltas out of the `-wal` file, so the connection
    // must run in WAL journal mode (better-sqlite3 defaults to rollback-journal
    // mode, which never produces a `-wal` file at all).
    connection.pragma('journal_mode = WAL');
    // Commit capture tracks progress through the `-wal` file by byte offset.
    // SQLite's automatic checkpointing (default ~1000 pages) can truncate or
    // reset that file on its own, silently invalidating the offset with no
    // error surfaced. Disable it — checkpoint-triggering is already out of
    // scope for this client, so letting the WAL grow unboundedly for the
    // life of one connection is an already-accepted limitation, not a new
    // problem introduced by turning this off.
    connection.pragma('wal_autocheckpoint = 0');
    return connection;
  }

  async _query(connection, obj) {
    const result = await super._query(connection, obj);
    if (connection.inTransaction === false) {
      await this._maybeCaptureCommit(connection);
    }
    return result;
  }

  async _maybeCaptureCommit() {
    const walPath = `${this.connectionSettings.filename}-wal`;
    let size;
    try {
      size = statSync(walPath).size;
    } catch {
      return; // no WAL file yet (e.g. a read-only autocommit statement before any write)
    }
    if (size <= this._lastWalOffset) return;

    const delta = Buffer.alloc(size - this._lastWalOffset);
    const fd = openSync(walPath, 'r');
    readSync(fd, delta, 0, delta.length, this._lastWalOffset);
    closeSync(fd);

    const isFirstCapture = this._lastWalOffset === 0;
    const pageSize = isFirstCapture ? parseWalHeader(delta).pageSize : this._pageSize;
    const frames = parseFrames(delta, pageSize, isFirstCapture ? 32 : 0);

    const committer = createCommitter({
      manifestStore: this._s3.manifestStore,
      segmentStore: this._s3.segmentStore,
    });
    const outcome = await committer.commitWalDelta(delta, frames);

    if (outcome.retryTransaction) {
      // By this point the write has already committed locally — there is no
      // local transaction left to "retry". A caller retry would duplicate
      // data. This writer's local state has now diverged from the shared
      // history; do NOT advance _lastWalOffset, so the next successful
      // capture naturally re-includes these bytes (plus whatever
      // accumulates after) in one larger delta/segment.
      throw new Error(
        "sqlite-s3: local write committed but lost an optimistic-concurrency race shipping to S3 — this writer's local state has now diverged from the shared history (see docs/superpowers/specs/2026-09-07-sqlite-s3-design.md's accepted risks; full reconciliation is a follow-up)"
      );
    }

    // Only advance past these bytes once they're confirmed durably shipped.
    this._pageSize = pageSize;
    this._lastWalOffset = size;
    this._s3.checkpointPolicy.recordSegment(delta.length);
  }
}
