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
    if (isFirstCapture) {
      this._pageSize = parseWalHeader(delta).pageSize;
    }
    const frames = parseFrames(delta, this._pageSize, isFirstCapture ? 32 : 0);
    this._lastWalOffset = size;

    const committer = createCommitter({
      manifestStore: this._s3.manifestStore,
      segmentStore: this._s3.segmentStore,
    });
    const outcome = await committer.commitWalDelta(delta, frames);
    this._s3.checkpointPolicy.recordSegment(delta.length);

    if (outcome.retryTransaction) {
      throw new Error(
        'sqlite-s3: write conflict detected on commit — caller must retry the transaction'
      );
    }
  }
}
