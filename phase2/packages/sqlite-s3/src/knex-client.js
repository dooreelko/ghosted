// Verified against knex@3.3.0 — adjust this import if it stops resolving.
import BetterSQLite3Client from 'knex/lib/dialects/better-sqlite3/index.js';
import { statSync, readSync, openSync, closeSync } from 'node:fs';
import { restoreLocalDb } from './restore.js';
import { createCommitter, fullJitterDelay } from './commit.js';
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
    // I1: guards around the fire-and-forget checkpoint kick-off in
    // _maybeCaptureCommit -- see there for why checkpointing must not run
    // inline (awaited) on the write path.
    this._checkpointInFlight = false;
    this._nextCheckpointAttemptAt = 0;
  }

  async acquireRawConnection() {
    const { manifest, etag } = await this._s3.manifestStore.read();
    this._manifest = manifest;
    const restoreStats = await restoreLocalDb({
      manifest,
      manifestStore: this._s3.manifestStore,
      segmentStore: this._s3.segmentStore,
      leaseStore: this._s3.leaseStore,
      dbPath: this.connectionSettings.filename,
    });
    // Purely observational -- unlike every other s3 config field, this one
    // is allowed a silent no-default fallback (it cannot affect
    // correctness, only visibility), so callers that don't care about
    // restore metrics don't have to wire anything.
    this._s3.onRestoreComplete?.(restoreStats);
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
    // Capture progress (`lastWalOffset`/`pageSize`) describes one physical
    // WAL file's read progress, which belongs to the CONNECTION, not to
    // whichever client-like object happens to call _maybeCaptureCommit.
    // Knex internally derives constructor-less clones of this client (e.g.
    // the "trxClient" it builds for knex.transaction()) that share this
    // class's prototype but never ran through `new SqliteS3Client(...)`, so
    // storing this state on `this` meant every one of those differently-
    // shaped `this`s restarted capture from scratch, re-shipping the ENTIRE
    // WAL history on every transaction. restoreLocalDb (page-image
    // reconstruction) never produces a `-wal` file — it writes an
    // already-consistent `.db` file directly — so there is never a restored
    // WAL to account for: capture progress always starts fresh here, exactly
    // as it does for a brand-new database.
    // `baseline` is the {manifest, etag} this connection's local db was just
    // restored from -- commitWalDelta's optimistic-concurrency check is only
    // meaningful against this, never against a fresh read taken at commit
    // time (a fresh read would almost always match what was just written,
    // silently defeating the overlap check on the fast/no-conflict path).
    connection.__sqliteS3State = { lastWalOffset: 0, pageSize: null, baseline: { manifest, etag } };
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
    // Capture progress lives on the CONNECTION (see acquireRawConnection),
    // not on `this` — `this` can be a constructor-less trxClient clone Knex
    // derives internally, which never gets its own instance state. Fall
    // back to a fresh shape defensively (shouldn't normally happen, since
    // acquireRawConnection always sets this) rather than propagating
    // undefined into arithmetic (undefined - number = NaN => Buffer.alloc(NaN)).
    const state = connection.__sqliteS3State ?? { lastWalOffset: 0, pageSize: null, baseline: { manifest: null, etag: null } };
    const lastWalOffset = state.lastWalOffset ?? 0;
    if (size <= lastWalOffset) return;

    const delta = Buffer.alloc(size - lastWalOffset);
    const fd = openSync(walPath, 'r');
    readSync(fd, delta, 0, delta.length, lastWalOffset);
    closeSync(fd);

    const isFirstCapture = lastWalOffset === 0;
    const pageSize = isFirstCapture ? parseWalHeader(delta).pageSize : state.pageSize;
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
    const outcome = await committer.commitWalDelta(payload, frames, pageSize, state.baseline);

    if (outcome.retryTransaction) {
      // By this point the write has already committed locally — there is no
      // local transaction left to "retry" as itself. This writer's local
      // state has now diverged from the shared history; do NOT advance
      // state.lastWalOffset, so the next successful capture naturally
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
    state.pageSize = pageSize;
    state.lastWalOffset = lastWalOffset + trimEnd;
    // This commit's own segment is now durably part of the shared history --
    // the next capture on this connection must treat it (and everything it
    // was appended onto) as the new known-synced baseline.
    state.baseline = { manifest: outcome.manifest, etag: outcome.etag };
    connection.__sqliteS3State = state;
    s3.checkpointPolicy.recordSegment(payload.length);

    // Checkpointing is a best-effort optimization (bounds restore time by
    // periodically merging the growing wal-segment history into a new base
    // segment) — never let a failure here break the caller's actual write.
    // I1: it must also never add its own latency (a full local restore plus
    // full reupload) directly to a caller's write, so this is a
    // fire-and-forget kick-off, not an awaited call. `_checkpointInFlight`
    // prevents overlapping attempts; `_nextCheckpointAttemptAt` is a
    // separate cooldown purely to stop hammering S3 with back-to-back
    // attempts (e.g. after an abandoned/conflicting one) -- it does NOT
    // stand in for `checkpointPolicy.recordCheckpoint()`, which is only
    // ever called on an actual `{checkpointed: true}` result so that an
    // abandoned attempt correctly leaves the size/time trigger still armed.
    try {
      if (
        s3.checkpointPolicy.shouldCheckpoint() &&
        !this._checkpointInFlight &&
        // `this` here can be a constructor-less trxClient clone (see the
        // extensive comments above on acquireRawConnection/
        // _maybeCaptureCommit) that never ran through this class's
        // constructor, so `_nextCheckpointAttemptAt` can be `undefined` on
        // it. `Date.now() >= undefined` is always false, which would
        // silently block checkpointing forever on any such clone — default
        // to 0 (no cooldown yet) rather than let a missing field read as
        // "permanently in cooldown."
        Date.now() >= (this._nextCheckpointAttemptAt ?? 0)
      ) {
        this._checkpointInFlight = true;
        const CHECKPOINT_COOLDOWN_MS = 30_000;
        performCheckpoint({ manifestStore: s3.manifestStore, segmentStore: s3.segmentStore, leaseStore: s3.leaseStore })
          .then((result) => {
            if (result.checkpointed) {
              s3.checkpointPolicy.recordCheckpoint();
            }
            // On abandonment (CAS conflict), deliberately do NOT call
            // recordCheckpoint() -- the size/time trigger should keep
            // believing WAL history is unbounded until a checkpoint
            // actually lands. The cooldown below is a separate,
            // independent mechanism purely to prevent hammering S3 with
            // overlapping attempts.
          })
          .catch((err) => {
            console.error('sqlite-s3: checkpoint attempt failed (non-fatal):', err);
          })
          .finally(() => {
            this._checkpointInFlight = false;
            this._nextCheckpointAttemptAt = Date.now() + CHECKPOINT_COOLDOWN_MS;
          });
      }
    } catch (err) {
      console.error('sqlite-s3: checkpoint attempt failed (non-fatal):', err);
    }
  }

  transaction(container, config, outerTx) {
    // The trxClient clone Knex builds internally to run queries inside a
    // transaction (see acquireRawConnection/_maybeCaptureCommit's comments)
    // is created via Object.create(...) and never runs this constructor, so
    // it has no `_s3` of its own. `_maybeCaptureCommit`'s fallback
    // (`this._s3 ?? registry.s3`) only works if `registry.s3` was already
    // populated — via the existing registerS3Config() — before the
    // transaction ran. At the point `transaction()` runs, `this` is always
    // the real, fully-constructed client (the trxClient clone doesn't exist
    // yet), so `this._s3` is valid here. Populate the registry from it
    // unconditionally, regardless of whether reconciliation retry is
    // actually enabled below — ANY knex.transaction() call, opted in or
    // not, can hit this same trxClient-has-no-`_s3` problem for ordinary
    // commit-capture.
    if (this._s3 && !registry.s3) {
      registry.s3 = this._s3;
    }

    // Reconciliation retry is opt-in, not automatic. `knex.transaction()`
    // has a second, callback-less calling form — `const trx = await
    // knex.transaction(); ...; await trx.commit();` — which Knex implements
    // by passing its own internal resolver function as `container`, not a
    // real user callback. Retrying that form the same way a real callback
    // gets retried deadlocks the connection pool forever (reproduced
    // directly: every later query hangs until the pool's acquire timeout).
    // There is no reliable way to distinguish the two calling forms here
    // without coupling to Knex-internal, version-specific details, so
    // retry only runs when the caller explicitly asks for it via
    // `knex.transaction(fn, { sqliteS3Reconcile: true })`. Every other
    // call — including the callback-less form, and every existing call in
    // Ghost's codebase today — delegates straight through with zero
    // behavior change from how it worked before reconciliation existed.
    if (outerTx || !config?.sqliteS3Reconcile) {
      // Nested transactions (savepoints) share the parent's connection —
      // retrying by discarding and reacquiring a connection would break
      // savepoint semantics in any case, so reconciliation never applies to
      // them regardless of the flag. Reconciliation only ever applies to
      // opted-in, top-level transactions.
      return super.transaction(container, config, outerTx);
    }
    // I2: `transaction()` itself must stay synchronous so the passthrough
    // branch above returns super.transaction(...)'s real Transaction object
    // (an EventEmitter with .on()/.isCompleted()/etc.) directly, not that
    // object wrapped in a plain Promise. The opted-in retry loop below needs
    // to be async, so it lives in this separate helper instead.
    return this._reconcilingTransaction(container, config, outerTx);
  }

  async _reconcilingTransaction(container, config, outerTx) {
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

        // I3: back off between attempts (same policy commit.js already
        // uses for its own CAS retry loop) so two contending writers don't
        // livelock through all 10 attempts with no delay between them.
        await new Promise((resolve) => setTimeout(resolve, fullJitterDelay(attempt)));
      }
    }
    throw lastErr;
  }
}
