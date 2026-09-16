// Verified against knex@3.3.0 — adjust this import if it stops resolving.
import BetterSQLite3Client from 'knex/lib/dialects/better-sqlite3/index.js';
import { statSync, readSync, openSync, closeSync } from 'node:fs';
import { restoreLocalDb } from './restore.js';
import { createCommitter, fullJitterDelay } from './commit.js';
import { parseWalHeader, parseFrames } from './wal.js';
import { extractPageImages, encodePageImages } from './page-images.js';
import { performCheckpoint } from './checkpoint.js';
import { ReaderClient } from './reader-client.js';
import { bumpRestoreGeneration } from './restore-generation.js';

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

// Module-level, keyed by db path (this.connectionSettings.filename): for a
// given local db file, at most one physical connection exists at a time
// (pool is pinned to max:1), so tracking one in-flight ship per db path is
// equivalent to tracking one per connection, and survives the connection
// object itself being discarded/disposed before its ship resolves.
//
// This must be keyed per db path, NOT a single process-wide scalar: more
// than one independent SqliteS3Client pool can be alive in the same
// process (Ghost + a separately-constructed knex-migrator pool per the
// constructor's comment above; this package's own tests construct a second,
// unrelated pool mid-ship to simulate an out-of-band writer). A single
// shared scalar makes one pool's acquire wait on a completely unrelated
// pool's ship, and can even deadlock: observed directly when a ship on pool
// A synchronously depends (via a stubbed store call) on a query against
// pool B, and pool B's acquire in turn waits on pool A's still-in-flight
// ship.
// Values are the never-rejecting ("swallowed") variant: acquireRawConnection
// and destroy() only need to wait for quiescence on this db path, not
// observe the outcome. This is also the serialization point for captures
// (see _captureAndScheduleShip) -- every new capture chains behind whatever
// is here, so at most one ship per db path is ever actually in flight.
const pendingShips = new Map(); // dbPath -> promise, never rejects

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
    const acquireTimeoutMillis = config.connection?.s3?.acquireTimeoutMillis ?? 15000;
    super({ ...config, pool: { min: 1, max: 1, acquireTimeoutMillis } });
    this._acquireRetries = config.connection?.s3?.acquireRetries ?? 1;
    this._s3 = config.connection.s3 ?? registry.s3;
    // I1: guards around the fire-and-forget checkpoint kick-off in
    // _maybeKickOffCheckpoint -- see there for why checkpointing must not run
    // inline (awaited) on the write path.
    this._checkpointInFlight = false;
    this._nextCheckpointAttemptAt = 0;
    // Guards routing reads to the reader pool before the writer has ever
    // restored the local file at least once (see acquireRawConnection,
    // which flips this true). ReaderClient never restores from S3 itself —
    // it only ever opens whatever is already on disk — so if a read were
    // the very first query this instance ever ran, routing it straight to
    // the reader pool would read (or silently create) an empty/stale local
    // file instead of triggering the writer's restore. Once this flips
    // true it stays true: after the writer's first acquire, the local file
    // is guaranteed current or newer for the rest of this instance's life.
    this._writerHasAcquired = false;

    // A separate, real multi-connection pool for read-only queries so a page
    // read never queues behind a held writer connection (the writer pool is
    // pinned to max:1 -- see above). Points at the SAME on-disk file the
    // writer maintains; see reader-client.js's doc comment for why opening
    // it concurrently with the writer (including mid-restore) is safe.
    const readerPoolSize = config.connection?.s3?.readerPoolSize ?? config?.readerPoolSize ?? 4;
    this._readerClient = new ReaderClient({
      ...config,
      acquireTimeoutMillis,
      pool: { ...config.pool, min: 1, max: readerPoolSize },
      connection: { filename: config.connection.filename },
    });
  }

  // Bounded retry on top of the short (config-controlled) per-attempt
  // acquire timeout set above: a single held-too-long writer connection
  // (the pool is pinned to max:1) should fail a caller fast rather than
  // hang for tarn's ~30s default, but one retry absorbs a connection that
  // frees up moments after the first attempt's timeout rather than
  // surfacing a spurious failure for that common case.
  async acquireConnection() {
    let lastErr;
    for (let attempt = 0; attempt <= this._acquireRetries; attempt += 1) {
      try {
        return await super.acquireConnection();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // Routes plain reads to the reader pool, everything else (writes, schema
  // DDL, raw SQL, transactions) stays on the writer pool via the inherited
  // runner. See _isReadOnlyBuilder for the conservative-by-construction
  // classification.
  runner(builder) {
    const runner = super.runner(builder);
    // `this.transacting` is set (true) only on the constructor-less
    // "trxClient" clone Knex builds for the life of a transaction (see
    // makeTxClient in knex's transaction.js) -- never on the real,
    // fully-constructed instance. Two independent reasons this must stay on
    // the writer: (1) that clone has no `_readerClient` of its own (it's
    // Object.create()'d, never run through this constructor), so routing
    // would hand the runner an undefined client; (2) even if it did, a read
    // inside a transaction must see that transaction's own uncommitted
    // writes and stay pinned to its single held connection -- a separate
    // reader-pool connection would never observe them.
    if (
      !this.transacting &&
      this._writerHasAcquired &&
      SqliteS3Client._isReadOnlyBuilder(builder)
    ) {
      runner.client = this._readerClient;
    }
    return runner;
  }

  // Conservative by construction: anything that isn't recognizably a plain
  // read (missing `_method`, e.g. a SchemaBuilder or Raw query, or a
  // `_method` outside the known read-only set) stays on the writer pool.
  // Misrouting a write to the reader pool would be a correctness bug;
  // misrouting a read to the writer pool only costs a little contention.
  static _isReadOnlyBuilder(builder) {
    const READ_ONLY_METHODS = new Set(['select', 'first', 'pluck', 'columnInfo']);
    return typeof builder?._method === 'string' && READ_ONLY_METHODS.has(builder._method);
  }

  async acquireRawConnection() {
    // Never restore while a previous connection's ship is still deciding
    // whether this write's bytes are durable (and whether it was a
    // conflict) -- restoring now could read stale S3 state and silently
    // lose the pending write, or race the disposal flag the ship sets.
    await (pendingShips.get(this.connectionSettings.filename) ?? Promise.resolve()).catch(() => {}); // errors are already logged where the ship runs; don't let them fail an unrelated new connection's acquire
    const { manifest, etag } = await this._s3.manifestStore.read();
    this._manifest = manifest;
    // restoreLocalDb's rewrite is atomic via write-to-temp-then-rename (Task
    // 3), which is what makes it safe for ReaderClient to open the same path
    // concurrently in the first place -- a reader always sees either the
    // fully-old or fully-new file, never a torn write. That guarantee is
    // about the FILE, not about any already-open reader connection's fd: a
    // rename swaps the directory entry to a new inode without touching
    // whatever inode an already-open fd points at, so a reader connection
    // opened before this rename would otherwise keep reading the old,
    // now-unlinked inode forever. bumpRestoreGeneration below (paired with
    // ReaderClient.validateConnection) is what forces such a connection to
    // be destroyed and reopened against the new inode next time it's handed
    // out of the pool -- see reader-client.js for the full mechanism.
    //
    // What this does NOT cover: a reader query already in flight at the
    // exact instant this rename happens can still return pre-restore rows
    // -- nothing here pauses or coordinates with an in-progress read on
    // another connection. That's a narrow, accepted window (the read was
    // already running against a valid, consistent snapshot; it just won't
    // see this particular restore's effects), not a bug to fix here.
    const restoreStats = await restoreLocalDb({
      manifest,
      manifestStore: this._s3.manifestStore,
      segmentStore: this._s3.segmentStore,
      leaseStore: this._s3.leaseStore,
      dbPath: this.connectionSettings.filename,
    });
    bumpRestoreGeneration(this.connectionSettings.filename);
    // Purely observational -- unlike every other s3 config field, this one
    // is allowed a silent no-default fallback (it cannot affect
    // correctness, only visibility), so callers that don't care about
    // restore metrics don't have to wire anything.
    this._s3.onRestoreComplete?.(restoreStats);
    this._writerHasAcquired = true;
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
    // whichever client-like object happens to call _captureAndScheduleShip.
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
    // Tracked on `this` (the real, fully-constructed client instance -- see
    // the comments on `transaction()` for why that's reliable even though
    // `this` inside _query/_captureAndScheduleShip can be a trxClient
    // clone) so _reconcilingTransaction can find the exact physical
    // connection a just-finished transaction used, without relying on any
    // shared per-dbPath map that a later, unrelated write could overwrite
    // first (see _reconcilingTransaction).
    this._currentConnection = connection;
    return connection;
  }

  async _query(connection, obj) {
    const result = await super._query(connection, obj);
    if (connection.inTransaction === false) {
      this._captureAndScheduleShip(connection);
    }
    return result;
  }

  _captureAndScheduleShip(connection) {
    // The S3 wiring is process-wide by nature (one Ghost process, one S3
    // bucket), so read it from the module-level registry directly rather
    // than trusting `this._s3` — some Knex-internal code paths invoke this
    // method with `this` bound to an object that shares SqliteS3Client's
    // prototype but was never run through `new SqliteS3Client(...)` (see
    // acquireRawConnection's comments), so `this._s3` may be unset on it.
    const s3 = this._s3 ?? registry.s3;
    const dbPath = this.connectionSettings.filename;

    // Serialize captures per db path: don't read the WAL delta for THIS
    // write until the previous ship for this path has fully settled and
    // (on success) advanced connection.__sqliteS3State. Capturing eagerly
    // here (the original version of this method) let two ships race on the
    // same still-stale state.lastWalOffset whenever a second write's commit
    // ran before the first write's S3 upload finished (the normal case now
    // that the connection is released immediately) — the second capture
    // would re-include frames the first ship was already shipping, its
    // commitWalDelta would then conflict (CAS overlap) against the first
    // one's just-landed segment, and since a conflict never advances state,
    // the connection got disposed with state reverted: the next restore
    // silently dropped every write after the first. The same unserialized
    // capture also let a plain SELECT re-capture and re-ship bytes a
    // still-in-flight write's ship hadn't advanced past yet, producing
    // duplicate segments. Chaining behind `pendingShips` (below) closes
    // both: at most one ship per db path is ever actually in flight, and
    // every capture always sees a fully up-to-date state.lastWalOffset.
    const previousShip = pendingShips.get(dbPath) ?? Promise.resolve();
    const chained = previousShip.then(() => {
      const captured = this._captureWalDelta(connection, s3);
      if (!captured) return; // nothing new to ship (see _captureWalDelta's early returns)
      return this._shipCapturedDelta(connection, s3, captured);
    });

    const shipAttempt = chained.catch((err) => {
      // The caller that made this write has already gotten its response by
      // now -- there is no request left to reject. Log and mark the
      // connection disposed (same recovery path this used to trigger
      // synchronously, pre-split) so the next acquire restores fresh.
      console.error('sqlite-s3: async commit ship failed:', err.message);
      if (connection) connection.__knex__disposed = err;
      throw err; // re-thrown so connection.__sqliteS3PendingShip (below) still rejects for _reconcilingTransaction to observe
    });
    pendingShips.set(dbPath, shipAttempt.catch(() => {})); // never-rejecting variant for acquireRawConnection/destroy gating and the next capture's chain link
    // Stashed on the connection itself, not just the shared per-dbPath map
    // above -- `pendingShips` can already have been overwritten by a LATER,
    // unrelated write's ship by the time a reconciling transaction gets a
    // chance to read it (see _reconcilingTransaction), which would make it
    // await the wrong ship entirely. The connection field always reflects
    // exactly the most recent capture attempt made ON THIS CONNECTION,
    // which for a reconciling transaction reading it immediately after its
    // own super.transaction() call resolves (before the connection is
    // handed to anything else) is guaranteed to be its own COMMIT's ship.
    if (connection) connection.__sqliteS3PendingShip = shipAttempt;
  }

  // Local-only: read the WAL delta off disk, identify the last committed
  // boundary, extract page images. Returns null if there's nothing new to
  // ship (no WAL growth, or no committed boundary in the delta yet).
  _captureWalDelta(connection, s3) {
    const walPath = `${this.connectionSettings.filename}-wal`;
    let size;
    try {
      size = statSync(walPath).size;
    } catch {
      return null; // no WAL file yet (e.g. a read-only autocommit statement before any write)
    }
    // Capture progress lives on the CONNECTION (see acquireRawConnection),
    // not on `this` — `this` can be a constructor-less trxClient clone Knex
    // derives internally, which never gets its own instance state. Fall
    // back to a fresh shape defensively (shouldn't normally happen, since
    // acquireRawConnection always sets this) rather than propagating
    // undefined into arithmetic (undefined - number = NaN => Buffer.alloc(NaN)).
    const state = connection.__sqliteS3State ?? { lastWalOffset: 0, pageSize: null, baseline: { manifest: null, etag: null } };
    const lastWalOffset = state.lastWalOffset ?? 0;
    if (size <= lastWalOffset) return null;

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
      return null;
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

    return { state, lastWalOffset, trimEnd, pageSize, frames, payload };
  }

  // Network: ship the captured delta to S3. Runs AFTER the connection has
  // already been released back to the pool by the caller of _query -- must
  // not touch `connection` for anything other than bookkeeping fields that
  // don't require exclusive access (state/checkpoint-in-flight flags),
  // since another query may already be running on it by the time this
  // resolves.
  async _shipCapturedDelta(connection, s3, captured) {
    const { state, lastWalOffset, trimEnd, pageSize, frames, payload } = captured;
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

    this._maybeKickOffCheckpoint(s3);
  }

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
  _maybeKickOffCheckpoint(s3) {
    try {
      if (
        s3.checkpointPolicy.shouldCheckpoint() &&
        !this._checkpointInFlight &&
        // `this` here can be a constructor-less trxClient clone (see the
        // extensive comments above on acquireRawConnection/
        // _captureAndScheduleShip) that never ran through this class's
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

  async destroy() {
    await (pendingShips.get(this.connectionSettings.filename) ?? Promise.resolve()).catch(() => {});
    await this._readerClient.destroy();
    return super.destroy();
  }

  // Ghost core's Settings.populateDefaults ("this is required for sqlite to
  // pick up the columns after db init") does `knex.destroy()` then
  // `knex.initialize()` on the SAME shared knex instance as a reconnect, not
  // a final teardown. knex's public `initialize()` (make-knex.js) calls
  // `this.client.initializePool(config)` DIRECTLY -- not `this.client
  // .initialize(...)` -- so overriding `initialize` here would never even
  // run; `initializePool` is the actual method that needs overriding.
  // Base `initializePool` only rebuilds the WRITER's own pool, with zero
  // knowledge of `_readerClient`, our own addition. Without this override,
  // the writer's pool comes back but the reader pool stays permanently
  // undefined after that point (destroy() sets `this.pool = undefined`, and
  // nothing ever calls initializePool on it again) -- every subsequent read
  // routed to it throws "Unable to acquire a connection" for the rest of
  // the process's life. Reproduced and root-caused against real prod boot
  // logs, 2026-09-16 (deployments 12/13).
  initializePool(config) {
    const result = super.initializePool(config);
    // `initializePool` also fires once from inside the base Client
    // constructor (via `super(config)`, before `this._readerClient` is
    // constructed a few lines later in THIS class's own constructor) -- on
    // that very first call there is nothing to reinitialize; the reader
    // gets its own fresh pool naturally when it's constructed. Only a LATER
    // call (Ghost's destroy()+initialize() reconnect) needs to also revive
    // the reader.
    this._readerClient?.initializePool();
    return result;
  }

  transaction(container, config, outerTx) {
    // The trxClient clone Knex builds internally to run queries inside a
    // transaction (see acquireRawConnection/_captureAndScheduleShip's
    // comments) is created via Object.create(...) and never runs this
    // constructor, so it has no `_s3` of its own. `_captureAndScheduleShip`'s
    // fallback (`this._s3 ?? registry.s3`) only works if `registry.s3` was already
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
        const result = await super.transaction(container, config, outerTx);
        // The transaction's COMMIT goes through _query -> _captureAndScheduleShip,
        // which now ships to S3 asynchronously (see Task 2) -- it can still be
        // in flight when super.transaction() above resolves. A conflict
        // discovered only once that ship settles must still trigger a retry,
        // so wait for it here before treating this attempt as successful.
        //
        // Read the ship promise off `this._currentConnection` (the exact
        // physical connection this transaction just used -- set by
        // acquireRawConnection), NOT off a shared per-dbPath map: a shared
        // map's entry for this db path can already have been overwritten by
        // a later, unrelated write's ship by the time we get here (this
        // continuation resumes a few microtask hops after the COMMIT ran),
        // which would make this await the WRONG ship -- either a stale
        // conflict from a totally unrelated write (falsely retrying a
        // read-only or already-successful transaction), or silently miss
        // this transaction's own real conflict entirely. The connection
        // field is written synchronously by _captureAndScheduleShip as part
        // of this transaction's own COMMIT, so reading it here -- before the
        // connection can be handed to any other query -- is guaranteed to be
        // this transaction's own ship (or, for a purely read-only
        // transaction that captured nothing new, a fast-resolving no-op).
        const connection = this._currentConnection;
        await (connection?.__sqliteS3PendingShip ?? Promise.resolve());
        return result;
      } catch (err) {
        if (!err.sqliteS3Conflict) throw err;
        lastErr = err;
        // The connection was marked __knex__disposed when the conflict was
        // detected (see _shipCapturedDelta), so the retried
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
