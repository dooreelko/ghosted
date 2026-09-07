// Verified against knex@3.3.0 — adjust this import if it stops resolving.
import BetterSQLite3Client from 'knex/lib/dialects/better-sqlite3/index.js';
import { statSync, readSync, openSync, closeSync } from 'node:fs';
import { restoreLocalDb } from './restore.js';
import { createCommitter } from './commit.js';
import { parseWalHeader, parseFrames } from './wal.js';

// Some hosts (observed with Ghost + knex-migrator) construct additional Knex
// clients from an independently re-derived copy of the connection config
// (e.g. Ghost's MigratorConfig.js snapshots `config.get('database')` at
// require-time for knex-migrator's own use). Passing this._s3 through that
// path is unreliable — a plain object nested with function-valued stores can
// fail to survive whatever cloning/merging produced that independent copy,
// even though a top-level class reference (`client: SqliteS3Client`) does.
// A process-wide registration point sidesteps that entirely: every
// SqliteS3Client instance in this process shares one S3 wiring, set once via
// `registerS3Config()` before Ghost/Knex boot, regardless of how many
// separately-constructed client instances end up existing.
const registry = { s3: undefined };

export function registerS3Config(s3Config) {
  registry.s3 = s3Config;
}

export class SqliteS3Client extends BetterSQLite3Client {
  constructor(config) {
    // This package's commit-capture logic assumes exactly one physical
    // connection is ever open at a time: acquireRawConnection() below
    // unconditionally deletes and rewrites the local .db/-wal/-shm files on
    // every acquire. Knex's default pool (min 2, max 10 for most dialects)
    // would let a second pooled connection acquire concurrently and delete
    // the database out from under the first connection's in-progress work.
    // Pin the pool to exactly one connection regardless of what's passed in
    // `config.pool` — this must happen before `super(config)`, since the
    // base Client constructor copies `config.pool` into `this.config.pool`
    // and synchronously initializes the pool from it.
    super({ ...config, pool: { min: 1, max: 1 } });
    this._s3 = config.connection.s3 ?? registry.s3;
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
    // restoreLocalDb may have just reconstructed a NON-EMPTY `-wal` file from
    // the manifest's segments. `_lastWalOffset` must start at the byte
    // length of whatever restore just wrote (0 if there's no `-wal` file at
    // all, e.g. a fresh/empty database) — NOT unconditionally 0 — otherwise
    // the next capture would re-ship the entire restored WAL history as a
    // brand-new duplicate segment. On a later restart that duplicate segment
    // sits in the middle of the manifest's segment list starting with a
    // second, unexpected 32-byte WAL header instead of a 24-byte frame
    // header, and SQLite's WAL recovery halts right there — silently
    // truncating away every real write that came after it.
    let restoredWalSize = 0;
    try {
      restoredWalSize = statSync(`${this.connectionSettings.filename}-wal`).size;
    } catch {
      // no -wal file — fresh/empty database, offset starts at 0
    }
    this._lastWalOffset = restoredWalSize;
    // If restore wrote a non-empty WAL, the next capture is no longer "the
    // first capture" in the `lastWalOffset === 0` sense, so
    // `_maybeCaptureCommit` won't derive `_pageSize` from the delta's own
    // header. Derive it here instead, from the restored `-wal` file's own
    // header (bytes 0-31) — the page size can't change within one WAL
    // file's lifetime, so this is exactly the value the next capture needs.
    if (restoredWalSize > 0) {
      const walFd = openSync(`${this.connectionSettings.filename}-wal`, 'r');
      const header = Buffer.alloc(32);
      readSync(walFd, header, 0, 32, 0);
      closeSync(walFd);
      this._pageSize = parseWalHeader(header).pageSize;
    } else {
      this._pageSize = null;
    }
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
    // Some Knex-internal code paths invoke this method with `this` bound to
    // an object that shares SqliteS3Client's prototype (so method lookup
    // resolves) but was never run through `new SqliteS3Client(...)` — e.g. a
    // lightweight clone Knex derives internally for pooling/transactions,
    // observed in practice from knex-migrator's own connection handling. Such
    // an object has none of this class's constructor-set instance state.
    // The S3 wiring is process-wide by nature (one Ghost process, one S3
    // bucket), so read it from the module-level registry directly rather
    // than trusting `this._s3` — that's robust regardless of what `this` is.
    const s3 = this._s3 ?? registry.s3;
    const walPath = `${this.connectionSettings.filename}-wal`;
    let size;
    try {
      size = statSync(walPath).size;
    } catch {
      return; // no WAL file yet (e.g. a read-only autocommit statement before any write)
    }
    // Some Knex-internal code paths (observed via knex-migrator's own connection
    // handling) construct client-like objects that never ran through our
    // constructor, leaving this undefined rather than the constructor's 0.
    // Treat a missing offset as "nothing captured yet" rather than propagating
    // undefined into arithmetic (undefined - number = NaN => Buffer.alloc(NaN)).
    const lastWalOffset = this._lastWalOffset ?? 0;
    if (size <= lastWalOffset) return;

    const delta = Buffer.alloc(size - lastWalOffset);
    const fd = openSync(walPath, 'r');
    readSync(fd, delta, 0, delta.length, lastWalOffset);
    closeSync(fd);

    const isFirstCapture = lastWalOffset === 0;
    const pageSize = isFirstCapture ? parseWalHeader(delta).pageSize : this._pageSize;
    const allFrames = parseFrames(delta, pageSize, isFirstCapture ? 32 : 0);

    // `connection.inTransaction === false` is also true immediately after a
    // ROLLBACK, and any frames a rolled-back transaction spilled into the
    // WAL file before rolling back remain physically present in it. SQLite
    // sets `dbSizeAfterCommit` to nonzero only on the last frame of an
    // actually-committed transaction, so use that to find the last real
    // commit boundary within this delta and discard anything after it
    // (orphaned rolled-back frames, or — shouldn't happen given the
    // `inTransaction` guard, but handled defensively anyway — a
    // still-in-progress transaction caught mid-write). Bytes after the trim
    // point are simply not considered captured yet: they're re-examined
    // (and re-trimmed, or included if a later real commit extends past
    // them) on the next capture attempt.
    let lastCommitFrameIndex = -1;
    for (let i = allFrames.length - 1; i >= 0; i -= 1) {
      if (allFrames[i].dbSizeAfterCommit !== 0) {
        lastCommitFrameIndex = i;
        break;
      }
    }
    if (lastCommitFrameIndex === -1) {
      // No committed-transaction boundary in this delta yet — nothing to ship.
      return;
    }
    const lastCommitFrame = allFrames[lastCommitFrameIndex];
    const trimEnd = lastCommitFrame.offset + lastCommitFrame.length;
    const trimmedDelta = delta.subarray(0, trimEnd);
    const frames = allFrames.slice(0, lastCommitFrameIndex + 1);

    const committer = createCommitter({
      manifestStore: s3.manifestStore,
      segmentStore: s3.segmentStore,
    });
    const outcome = await committer.commitWalDelta(trimmedDelta, frames);

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
    // Advance by the trimmed amount, not the full delta — any bytes after
    // the last commit boundary (e.g. a rolled-back transaction's orphaned
    // frames) are not yet considered captured.
    this._pageSize = pageSize;
    this._lastWalOffset = lastWalOffset + trimEnd;
    s3.checkpointPolicy.recordSegment(trimmedDelta.length);
  }
}
