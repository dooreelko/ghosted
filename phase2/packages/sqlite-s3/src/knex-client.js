// Verified against knex@3.3.0 — adjust this import if it stops resolving.
import BetterSQLite3Client from 'knex/lib/dialects/better-sqlite3/index.js';
import { statSync, readSync, openSync, closeSync } from 'node:fs';
import { restoreLocalDb } from './restore.js';
import { createCommitter } from './commit.js';
import { parseWalHeader, parseFrames } from './wal.js';
import { extractPageImages, encodePageImages } from './page-images.js';
import { performCheckpoint } from './checkpoint.js';

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
    // restoreLocalDb (page-image reconstruction) never produces a `-wal`
    // file — it writes an already-consistent `.db` file directly. So there
    // is never a restored WAL to account for: capture progress always
    // starts fresh, exactly as it does for a brand-new database.
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

  async _maybeCaptureCommit(connection) {
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
    const frames = allFrames.slice(0, lastCommitFrameIndex + 1);

    // Extract page images from the trimmed frames (deduped last-write-wins
    // per page) and encode them as this segment's payload — see
    // docs/superpowers/specs/2026-09-07-sqlite-s3-design.md's Revision note
    // for why this replaced shipping raw WAL bytes (final review finding C2:
    // WAL checksum chains can't be spliced across independent writers).
    const pages = extractPageImages(delta, frames, pageSize);
    const payload = encodePageImages(pages);

    const committer = createCommitter({
      manifestStore: s3.manifestStore,
      segmentStore: s3.segmentStore,
    });
    const outcome = await committer.commitWalDelta(payload, frames, pageSize);

    if (outcome.retryTransaction) {
      // By this point the write has already committed locally — there is no
      // local transaction left to "retry" as itself. This writer's local
      // state has now diverged from the shared history; do NOT advance
      // _lastWalOffset, so the next successful capture naturally
      // re-includes these bytes (plus whatever accumulates after) in one
      // larger delta/segment.
      const err = new Error(
        "sqlite-s3: local write committed but lost an optimistic-concurrency race shipping to S3 — this writer's local state has diverged from the shared history"
      );
      // Tag so `transaction()` below knows this is a safe-to-retry conflict,
      // not an arbitrary error the caller should just see.
      err.sqliteS3Conflict = true;
      // Mark the connection disposed so Knex's pool discards it and the next
      // acquire runs acquireRawConnection() again, which restores fresh
      // state from S3 — this is an existing Knex convention (used
      // internally by Knex's own dialects), not something this package
      // invented; see Step 1's verification.
      if (connection) {
        connection.__knex__disposed = err;
      }
      throw err;
    }

    // Only advance past these bytes once they're confirmed durably shipped.
    // Advance by the trimmed amount, not the full delta — any bytes after
    // the last commit boundary (e.g. a rolled-back transaction's orphaned
    // frames) are not yet considered captured.
    this._pageSize = pageSize;
    this._lastWalOffset = lastWalOffset + trimEnd;
    s3.checkpointPolicy.recordSegment(payload.length);

    // Checkpointing is a best-effort optimization (bounds restore time by
    // periodically merging the growing wal-segment history into a new base
    // segment) — never let a failure here break the caller's actual write.
    try {
      if (s3.checkpointPolicy.shouldCheckpoint()) {
        const result = await performCheckpoint({
          manifestStore: s3.manifestStore,
          segmentStore: s3.segmentStore,
        });
        if (result.checkpointed) {
          s3.checkpointPolicy.recordCheckpoint();
        }
      }
    } catch (err) {
      console.error('sqlite-s3: checkpoint attempt failed (non-fatal):', err);
    }
  }

  async transaction(container, config, outerTx) {
    if (outerTx) {
      // Nested transactions (savepoints) share the parent's connection —
      // retrying by discarding and reacquiring a connection would break
      // savepoint semantics. Reconciliation only applies to top-level
      // transactions.
      return super.transaction(container, config, outerTx);
    }
    const MAX_RECONCILE_ATTEMPTS = 10;
    let lastErr;
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
      try {
        return await super.transaction(container, config, outerTx);
      } catch (err) {
        if (!err.sqliteS3Conflict) throw err;
        lastErr = err;
        // The connection was marked __knex__disposed when the conflict was
        // detected (see _maybeCaptureCommit), so the retried
        // super.transaction() call below will acquire a fresh connection —
        // re-running restoreLocalDb against the now-current S3 state —
        // before re-invoking `container` against that fresh state.
      }
    }
    throw lastErr;
  }
}
