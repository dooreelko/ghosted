import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knexFactory from 'knex';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { createManifestStore } from '../src/manifest.js';
import { createCheckpointPolicy } from '../src/checkpoint.js';
import { createLeaseStore } from '../src/leases.js';
import { SqliteS3Client, registerS3Config } from '../src/knex-client.js';

async function tmpDbPath() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sqlite-s3-knex-test-'));
  return path.join(dir, 'app.db');
}

function makeS3Config(store) {
  return {
    manifestStore: createManifestStore(store),
    segmentStore: createSegmentStore(store),
    checkpointPolicy: createCheckpointPolicy({ maxWalBytes: 10_000_000, maxIntervalMs: 3_600_000 }),
    leaseStore: createLeaseStore(store),
  };
}

function makeKnex(dbPath, s3Config) {
  return knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: s3Config },
    useNullAsDefault: true,
  });
}

// Wraps every method of an object store with an artificial delay so ships
// (which make several store calls per commitWalDelta -- manifest read,
// segment put, manifest write) take long enough in wall-clock time for a
// SECOND write's capture to have a real chance to start before the first
// write's ship has settled. createInMemoryObjectStore()'s calls all settle
// synchronously-ish (same-tick microtasks), so consecutive AWAITED
// statements never see an overlapping in-flight ship with it -- the race
// window this is meant to open never opens, which is why the earlier
// (unserialized) capture/ship bug wasn't caught by any test using the
// plain in-memory store.
function withLatency(store, delayMs = 15) {
  const delay = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  const wrapped = {};
  for (const key of Object.keys(store)) {
    const fn = store[key];
    wrapped[key] = async (...args) => {
      await delay();
      return fn.apply(store, args);
    };
  }
  return wrapped;
}

test('acquireRawConnection forwards restoreLocalDb\'s stats to s3.onRestoreComplete', async () => {
  const store = createInMemoryObjectStore();
  const dbPathA = await tmpDbPath();
  const knexA = makeKnex(dbPathA, makeS3Config(store));
  await knexA.schema.createTable('widgets', (t) => {
    t.increments('id');
    t.string('name');
  });
  await knexA('widgets').insert({ name: 'gizmo' });
  await knexA.destroy();

  const calls = [];
  const s3Config = { ...makeS3Config(store), onRestoreComplete: (stats) => calls.push(stats) };
  const dbPathB = await tmpDbPath();
  const knexB = makeKnex(dbPathB, s3Config);
  await knexB('widgets').select('*');
  await knexB.destroy();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].attempts, 1);
  assert.equal(typeof calls[0].durationMs, 'number');
});

test('acquireRawConnection tolerates a missing s3.onRestoreComplete (no hook wired)', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const knex = makeKnex(dbPath, makeS3Config(store));
  await knex.schema.createTable('widgets', (t) => {
    t.increments('id');
  });
  await knex.destroy();
});

test('data written via one Knex instance is visible after a simulated restart', async () => {
  const store = createInMemoryObjectStore();
  const dbPathA = await tmpDbPath();

  const knexA = makeKnex(dbPathA, makeS3Config(store));
  await knexA.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
  });
  await knexA('posts').insert({ title: 'hello world' });
  await knexA.destroy();

  // Simulate a restart: new process, new local file path, same S3-backed store.
  const dbPathB = await tmpDbPath();
  const knexB = makeKnex(dbPathB, makeS3Config(store));
  const rows = await knexB('posts').select('*');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'hello world');
  await knexB.destroy();
});

// Regression test for C1: after restoreLocalDb reconstructs a non-empty
// `-wal` file from the manifest's segments, _lastWalOffset must start at
// that file's actual size, not 0 — otherwise the next capture re-ships the
// entire restored WAL history as a duplicate segment, and a SECOND restart
// halts WAL recovery at that duplicate segment's unexpected embedded WAL
// header, silently losing every write made between the first and second
// restart.
test('data survives two successive simulated restarts (C1: no duplicate-shipping of restored WAL)', async () => {
  const store = createInMemoryObjectStore();
  const dbPathA = await tmpDbPath();

  const knexA = makeKnex(dbPathA, makeS3Config(store));
  await knexA.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
  });
  await knexA('posts').insert({ title: 'first instance' });
  await knexA.destroy();

  // First simulated restart: restore from S3, then write more data.
  const dbPathB = await tmpDbPath();
  const knexB = makeKnex(dbPathB, makeS3Config(store));
  await knexB('posts').insert({ title: 'second instance' });
  await knexB.destroy();

  // Second simulated restart: restore from S3 again.
  const dbPathC = await tmpDbPath();
  const knexC = makeKnex(dbPathC, makeS3Config(store));
  const rows = await knexC('posts').select('*').orderBy('id');
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.title),
    ['first instance', 'second instance']
  );
  await knexC.destroy();
});

test('a checkpoint runs when the policy says to, and merges accumulated commits into a new base segment', async () => {
  const store = createInMemoryObjectStore();
  const dbPathA = await tmpDbPath();

  // A checkpoint policy that says "checkpoint" as soon as ANY bytes have
  // been recorded, so this test doesn't depend on real size/time thresholds.
  const manifestStore = createManifestStore(store);
  const segmentStore = createSegmentStore(store);
  const leaseStore = createLeaseStore(store);
  let recorded = 0;
  const checkpointPolicy = {
    recordSegment: (n) => { recorded += n; },
    shouldCheckpoint: () => recorded > 0,
    recordCheckpoint: () => { recorded = 0; },
  };

  const knexA = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPathA, s3: { manifestStore, segmentStore, checkpointPolicy, leaseStore } },
    useNullAsDefault: true,
  });
  // I1: checkpointing is now a rate-limited (cooldown-guarded), fire-and-
  // forget kick-off rather than something awaited inline on every commit —
  // so two separate top-level statements (schema creation, then an insert)
  // would each independently trigger a commit/capture cycle, and the
  // SECOND cycle's checkpoint attempt would be suppressed by the first
  // checkpoint's cooldown, leaving its own segment uncleared for the
  // 30-second cooldown window. Batch both statements into a single
  // transaction so this test produces exactly one commit/capture cycle
  // (and therefore one checkpoint attempt) — this changes nothing about
  // what the test proves, only how many WAL commits it produces.
  await knexA.transaction(async (trx) => {
    await trx.schema.createTable('posts', (t) => {
      t.increments('id');
      t.string('title');
    });
    await trx('posts').insert({ title: 'hello' });
  });
  await knexA.destroy();

  // Checkpointing is now fire-and-forget (kicked off from
  // _maybeCaptureCommit but not awaited on the write path), so its effects
  // on the manifest may land slightly after the transaction's own promise
  // resolves. Poll briefly instead of asserting immediately.
  let manifest;
  const deadline = Date.now() + 2000;
  do {
    ({ manifest } = await manifestStore.read());
    if (manifest.baseSegmentId && manifest.walSegmentIds.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);

  assert.ok(manifest.baseSegmentId, 'a base segment must exist after a checkpoint ran');
  assert.deepEqual(manifest.walSegmentIds, [], 'wal segments must be cleared after checkpointing');

  // Data must still be intact after the checkpoint, from a fresh instance.
  const dbPathB = await tmpDbPath();
  const knexB = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPathB, s3: { manifestStore, segmentStore, checkpointPolicy: makeS3Config(store).checkpointPolicy, leaseStore } },
    useNullAsDefault: true,
  });
  const rows = await knexB('posts').select('*');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'hello');
  await knexB.destroy();
});

test('a checkpoint failure does not break the caller\'s actual write', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const segmentStore = createSegmentStore(store);
  const manifestStore = {
    read: async () => { throw new Error('boom: simulated checkpoint read failure'); },
    write: createManifestStore(store).write,
  };
  const checkpointPolicy = {
    recordSegment: () => {},
    shouldCheckpoint: () => true, // always try to checkpoint
    recordCheckpoint: () => {},
  };

  // Use a SEPARATE, working manifestStore for the actual commit path, and only
  // make performCheckpoint's own read() call fail — simulate this by using a
  // real manifestStore for commits but asserting the write still succeeds
  // even though checkpointing will throw internally when it tries to read.
  const realManifestStore = createManifestStore(store);
  const leaseStore = createLeaseStore(store);
  const knex = knexFactory({
    client: SqliteS3Client,
    connection: {
      filename: dbPath,
      s3: {
        manifestStore: realManifestStore,
        segmentStore,
        leaseStore,
        checkpointPolicy: {
          recordSegment: () => {},
          shouldCheckpoint: () => { throw new Error('boom: simulated checkpoint policy failure'); },
          recordCheckpoint: () => {},
        },
      },
    },
    useNullAsDefault: true,
  });

  await knex.schema.createTable('posts', (t) => {
    t.increments('id');
  });
  // If checkpoint wiring isn't wrapped in try/catch, this insert would reject.
  await knex('posts').insert({});
  const rows = await knex('posts').select('*');
  assert.equal(rows.length, 1);
  await knex.destroy();
});

// Regression test for I3: the pool must always be pinned to exactly one
// connection, regardless of what's passed in `config.pool` — otherwise a
// second pooled connection could acquire concurrently and delete the local
// database out from under the first connection's in-progress work.
test('pool is pinned to min:1, max:1 regardless of what is passed in config.pool', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();

  const knex = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: makeS3Config(store) },
    useNullAsDefault: true,
    pool: { min: 5, max: 20 },
  });
  try {
    assert.deepEqual(knex.client.config.pool, { min: 1, max: 1 });
    assert.equal(knex.client.pool.min, 1);
    assert.equal(knex.client.pool.max, 1);
  } finally {
    await knex.destroy();
  }
});

// Regression test for I4: frames a rolled-back transaction spilled into the
// WAL before rolling back must never be shipped as a durable segment, and a
// real committed write landing after them must never be silently dropped.
test('a rolled-back transaction is not shipped, and a subsequent real commit survives a restart (I4)', async () => {
  const store = createInMemoryObjectStore();
  const dbPathA = await tmpDbPath();

  const knexA = makeKnex(dbPathA, makeS3Config(store));
  await knexA.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
  });

  // Drive raw SQL through Knex's own query path (not a direct raw-connection
  // call) so the client's `_query` hook — and thus `_maybeCaptureCommit` —
  // actually fires after the ROLLBACK, exactly as it would in production.
  await knexA.raw('BEGIN');
  await knexA.raw("insert into posts (title) values ('rolled back row')");
  await knexA.raw('ROLLBACK');

  // Now perform a real, committed write.
  await knexA('posts').insert({ title: 'committed row' });
  await knexA.destroy();

  const dbPathB = await tmpDbPath();
  const knexB = makeKnex(dbPathB, makeS3Config(store));
  const rows = await knexB('posts').select('*');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'committed row');
  await knexB.destroy();
});

// Regression test for C2: segments committed by two SEPARATE Knex/SqliteS3Client
// instances (simulating two real concurrent writer processes, each with its own
// local file and its own independently-random WAL header salts) must both survive
// being restored by a third instance. This is the scenario raw-WAL-byte segments
// could not support — writer B's segment would corrupt recovery at the seam where
// it was spliced onto writer A's WAL history.
test('data committed by two independent writer instances both survive a later restore (C2)', async () => {
  const store = createInMemoryObjectStore();

  const dbPathA = await tmpDbPath();
  const knexA = makeKnex(dbPathA, makeS3Config(store));
  await knexA.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
  });
  await knexA('posts').insert({ title: 'from writer A' });
  await knexA.destroy();

  // Writer B: a SEPARATE instance that restores from the same S3 state (so it
  // picks up writer A's table) and then writes its own row — a genuinely
  // independent local file with its own WAL lineage, not a continuation of A's.
  const dbPathB = await tmpDbPath();
  const knexB = makeKnex(dbPathB, makeS3Config(store));
  await knexB('posts').insert({ title: 'from writer B' });
  await knexB.destroy();

  // A third instance restoring from the shared S3 state must see both rows.
  const dbPathC = await tmpDbPath();
  const knexC = makeKnex(dbPathC, makeS3Config(store));
  const rows = await knexC('posts').select('title').orderBy('id');
  assert.deepEqual(
    rows.map((r) => r.title),
    ['from writer A', 'from writer B']
  );
  await knexC.destroy();
});

// Task 4: transaction() reconciliation. The brief's own test sketch used a
// mocked manifestStore.write that didn't force a REAL page-level conflict
// (it was flagged as needing adjustment). This version forces a genuine
// conflict by having a completely separate writer instance (knexB) commit a
// real, independent update to the EXACT SAME ROW that knexA's transaction is
// also updating, in the narrow window between knexA's manifest read and its
// manifest write landing. Because both writers touch the same SQLite page,
// commit.js's overlap check is guaranteed to detect a real conflict (not
// merely a manifest-etag race it could silently fast-forward past), so this
// exercises the actual reconciliation path rather than an artificial one.
test('a knex.transaction() callback is safely re-invoked against fresh state after losing a conflict race', async () => {
  const store = createInMemoryObjectStore();
  // Both writers below get their own manifestStore/segmentStore/checkpointPolicy
  // instances (as two real, independent writer processes would), all backed
  // by the same underlying shared S3 object store.
  const s3ConfigA = makeS3Config(store);
  const manifestStoreA = s3ConfigA.manifestStore;

  const dbPathA = await tmpDbPath();
  const knexA = makeKnex(dbPathA, s3ConfigA);

  await knexA.schema.createTable('counters', (t) => {
    t.string('name').primary();
    t.integer('value');
  });
  await knexA('counters').insert({ name: 'hits', value: 0 });

  // Knex builds a lightweight "trxClient" clone for every query run inside
  // knex.transaction() (see node_modules/knex/lib/execution/transaction.js's
  // makeTxClient) that shares SqliteS3Client's prototype but skips the
  // constructor, so it never gets its own `_s3`. `_maybeCaptureCommit`
  // already falls back to the module-level registry for exactly this case
  // (see its comment) — register knexA's config so the COMMIT query (which
  // runs through that trxClient) can find it. Reset it after this test so it
  // doesn't leak into other tests in this file.
  registerS3Config(s3ConfigA);

  // From this point on, intercept knexA's manifest writes. On the FIRST
  // call (made by the transaction under test below), let a totally separate
  // writer (knexB) commit a real, independent change to the SAME row first,
  // so that knexA's own write — still carrying the etag it read before
  // knexB's write landed — genuinely loses the CAS race.
  let writeAttempts = 0;
  const realWriteA = manifestStoreA.write.bind(manifestStoreA);
  manifestStoreA.write = async (manifest, opts) => {
    writeAttempts += 1;
    if (writeAttempts === 1) {
      const dbPathB = await tmpDbPath();
      const knexB = makeKnex(dbPathB, makeS3Config(store));
      await knexB('counters').where({ name: 'hits' }).update({ value: 100 });
      await knexB.destroy();
    }
    return realWriteA(manifest, opts);
  };

  let attemptCount = 0;
  try {
    const result = await knexA.transaction(
      async (trx) => {
        attemptCount += 1;
        const row = await trx('counters').where({ name: 'hits' }).first();
        await trx('counters').where({ name: 'hits' }).update({ value: row.value + 1 });
        return row.value + 1;
      },
      { sqliteS3Reconcile: true }
    );

    assert.equal(writeAttempts, 2, 'the manifest write must have genuinely conflicted once, then succeeded on retry');
    assert.equal(attemptCount, 2, 'the transaction callback must have been re-invoked exactly once after the conflict');
    // The retried callback must have observed knexB's committed value (100),
    // proving it ran against genuinely fresh state restored from S3 — not the
    // stale value (0) the first attempt saw, and not zero re-invocations.
    assert.equal(result, 101, 'the result must reflect exactly one increment applied on top of the fresh (post-conflict) state, not zero or double-applied');

    const finalRow = await knexA('counters').where({ name: 'hits' }).first();
    assert.equal(finalRow.value, 101, 'exactly one increment must be reflected on top of the fresh state, not zero or double-counted');
  } finally {
    registerS3Config(undefined);
    await knexA.destroy();
  }
});

// Regression coverage for a bug found in code review:
// _reconcilingTransaction used to await a shared per-dbPath map entry
// (`lastShips.get(dbPath)`) rather than the specific ship THIS transaction's
// own COMMIT scheduled. A read-only reconciling transaction captures
// nothing new (there's no WAL growth to ship), so that map entry was
// whatever an EARLIER, unrelated write happened to leave behind -- if that
// earlier write had conflicted, this purely read-only transaction would
// wrongly retry up to 10 times and eventually throw a bogus conflict, even
// though it never wrote anything and never actually raced anyone.
test('a read-only reconciling transaction does not retry or throw because of an unrelated earlier write\'s conflict', async () => {
  const store = createInMemoryObjectStore();
  const s3ConfigA = makeS3Config(store);
  const manifestStoreA = s3ConfigA.manifestStore;
  const dbPathA = await tmpDbPath();
  const knexA = makeKnex(dbPathA, s3ConfigA);
  registerS3Config(s3ConfigA);

  try {
    await knexA.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });

    // Force the NEXT manifest write to conflict, by letting a totally
    // separate writer (knexB) land a real write first against the same key.
    const realWriteA = manifestStoreA.write.bind(manifestStoreA);
    let forcedConflict = false;
    manifestStoreA.write = async (manifest, opts) => {
      if (!forcedConflict) {
        forcedConflict = true;
        const dbPathB = await tmpDbPath();
        const knexB = makeKnex(dbPathB, makeS3Config(store));
        await knexB('widgets').insert({ name: 'from-knexB' });
        await knexB.destroy();
      }
      return realWriteA(manifest, opts);
    };

    // This write's own ship will genuinely conflict and get disposed --
    // that's expected and not what's under test. What matters is that it
    // doesn't corrupt state for the READ-ONLY transaction that follows.
    await knexA('widgets').insert({ name: 'from-knexA' }).catch(() => {});
    // Give the async ship a moment to actually run and (fail to) land,
    // leaving a rejected entry behind for this db path.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const start = Date.now();
    const result = await knexA.transaction(
      async (trx) => {
        const rows = await trx('widgets').select('*');
        return rows.length;
      },
      { sqliteS3Reconcile: true }
    );
    const elapsedMs = Date.now() - start;

    assert.equal(typeof result, 'number', 'the read-only transaction must complete and return normally, not throw');
    assert.ok(
      elapsedMs < 2000,
      `a read-only transaction must not pay for reconciliation retries/backoff (took ${elapsedMs}ms) — it should resolve near-instantly`
    );
  } finally {
    registerS3Config(undefined);
    await knexA.destroy();
  }
});

// Critical fix: reconciliation retry must be opt-in, not automatic — the
// callback-less `knex.transaction()` calling form (no `container` argument;
// Knex passes its own internal resolver in its place) must keep working
// exactly as it always did. Before this fix, EVERY knex.transaction() call
// went through the retry loop, which deadlocks that calling form's pool
// forever on a conflict; this test proves the calling form itself still
// completes normally with no conflict involved, i.e. it isn't broken by
// anything added to transaction() in this file.
test('knex.transaction() with no callback (callback-less form) still completes normally', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const knex = makeKnex(dbPath, makeS3Config(store));
  try {
    await knex.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });

    const trx = await knex.transaction();
    await trx('widgets').insert({ name: 'gizmo' });
    await trx.commit();

    const rows = await knex('widgets').select('*');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'gizmo');
  } finally {
    await knex.destroy();
  }
});

// Important #1 fix: registry.s3 must get populated from `this._s3` inside
// transaction() itself, so reconciliation works even for a caller who wires
// up SqliteS3Client purely via `connection: {s3: {...}}` (this package's own
// documented approach, used by every other test in this file) and never
// calls registerS3Config() directly. Explicitly clear the registry first —
// an earlier test in this file (the conflict-reconciliation test above) may
// have already left it populated from ITS OWN _s3, which would let this test
// pass by accident rather than actually proving the fix.
test('knex.transaction({sqliteS3Reconcile: true}) works without ever calling registerS3Config()', async () => {
  registerS3Config(undefined); // ensure no leaked config from an earlier test
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const knex = makeKnex(dbPath, makeS3Config(store));
  try {
    await knex.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });

    // Must not throw "Cannot read properties of undefined (reading
    // 'manifestStore')" — which is what happens if the trxClient clone
    // Knex builds internally can't find S3 wiring via `this._s3 ??
    // registry.s3` during commit-capture.
    const result = await knex.transaction(
      async (trx) => {
        await trx('widgets').insert({ name: 'sprocket' });
        return 'ok';
      },
      { sqliteS3Reconcile: true }
    );
    assert.equal(result, 'ok');

    const rows = await knex('widgets').select('*');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'sprocket');
  } finally {
    registerS3Config(undefined);
    await knex.destroy();
  }
});

// Important #2 fix: capture state (lastWalOffset/pageSize) must live on the
// CONNECTION, not on `this` — otherwise every transaction's trxClient clone
// (which has no instance state of its own) resets capture to "nothing
// shipped yet," causing the NEXT ordinary write's capture to re-parse and
// re-ship the entire WAL history (including a prior rolled-back
// transaction's orphaned frames) as an inflated write-set. This test rolls
// back a transaction with real writes inside it, then performs a genuinely
// separate, small, real committed write outside any transaction, and checks
// the shipped segment's write-set only reflects that second write's own
// pages.
test('a rolled-back transaction does not inflate the write-set of a later, separate commit (Important #2)', async () => {
  const store = createInMemoryObjectStore();
  const s3Config = makeS3Config(store);
  const dbPath = await tmpDbPath();
  const knex = makeKnex(dbPath, s3Config);
  try {
    await knex.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });
    // The table creation above already shipped a segment; note how many
    // segments exist before the rollback + follow-up write so we can find
    // the NEW one shipped by the follow-up write specifically.
    const before = await s3Config.manifestStore.read();
    const segmentCountBefore = before.manifest.walSegmentIds.length;

    // A transaction with real writes that then rolls back — its frames get
    // physically spilled into the -wal file before the ROLLBACK, but must
    // never be captured/shipped since the transaction never committed.
    await assert.rejects(
      knex.transaction(async (trx) => {
        // Insert several rows so real WAL frames get written before the
        // deliberate failure below triggers a rollback.
        for (let i = 0; i < 5; i += 1) {
          await trx('widgets').insert({ name: `rolled-back-${i}` });
        }
        throw new Error('deliberate rollback');
      })
    );

    // A genuinely separate, small, real committed write outside any
    // transaction.
    await knex('widgets').insert({ name: 'the-real-one' });

    const after = await s3Config.manifestStore.read();
    const newSegmentIds = after.manifest.walSegmentIds.slice(segmentCountBefore);
    assert.equal(newSegmentIds.length, 1, 'exactly one new segment must have been shipped for the follow-up write');

    const seg = await s3Config.segmentStore.getSegment(newSegmentIds[0]);
    // A single one-row insert into a small, already-created table touches
    // very few pages (root/page for the table + any index/freelist
    // bookkeeping) — nowhere near what re-shipping the rolled-back
    // transaction's 5 inserts on top of it would produce. Assert the
    // write-set is small and plausible, not inflated.
    assert.ok(Array.isArray(seg.meta.writeSet), 'segment must carry a writeSet');
    assert.ok(
      seg.meta.writeSet.length <= 3,
      `write-set for a single small insert must be small (got ${seg.meta.writeSet.length} pages: ${JSON.stringify(seg.meta.writeSet)}) — an inflated write-set means the rolled-back transaction's frames leaked into this capture`
    );

    const rows = await knex('widgets').select('*').orderBy('id');
    assert.equal(rows.length, 1, 'only the real committed write must be visible — the rolled-back inserts must not appear');
    assert.equal(rows[0].name, 'the-real-one');
  } finally {
    await knex.destroy();
  }
});

test('the connection is released back to the pool before the S3 upload for that write completes', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();

  // A segmentStore whose putSegment() we can stall, so we can observe pool
  // state WHILE a ship is still in flight.
  const realSegmentStore = createSegmentStore(store);
  let releasePut;
  const stallOnce = new Promise((resolve) => { releasePut = resolve; });
  let putCalls = 0;
  const segmentStore = {
    ...realSegmentStore,
    putSegment: async (...args) => {
      putCalls += 1;
      if (putCalls === 1) await stallOnce;
      return realSegmentStore.putSegment(...args);
    },
  };
  const s3Config = {
    manifestStore: createManifestStore(store),
    segmentStore,
    leaseStore: createLeaseStore(store),
    checkpointPolicy: createCheckpointPolicy({ maxWalBytes: 10_000_000, maxIntervalMs: 3_600_000 }),
  };
  const knex = makeKnex(dbPath, s3Config);
  try {
    await knex.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });

    // This insert's ship (putSegment) is now stalled mid-flight. If the
    // connection were still held for the ship's duration, a second query
    // issued right now would hang until stallOnce resolves. Assert it
    // does NOT hang.
    const insertDone = knex('widgets').insert({ name: 'gizmo' });
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the insert's capture phase run

    const secondQueryStarted = Date.now();
    // Only the timing matters here: whether the inserted row is already
    // visible to this SELECT depends on exactly which statement's ship got
    // stalled first (CREATE TABLE's or the insert's) and is not what this
    // test is proving -- asserting its contents would either be incidental
    // or require pinning down capture/ship ordering unrelated to the point
    // being tested (that the pool doesn't block on the in-flight upload).
    await knex('widgets').select('*'); // must not queue behind the stalled ship
    assert.ok(Date.now() - secondQueryStarted < 500, 'second query queued behind the in-flight S3 upload');

    releasePut();
    await insertDone;
  } finally {
    await knex.destroy();
  }
});

test('acquireRawConnection waits for the previous connection\'s pending ship before restoring (ordering constraint)', async () => {
  const store = createInMemoryObjectStore();
  const dbPathA = await tmpDbPath();

  const realManifestStore = createManifestStore(store);
  let releaseWrite;
  const stallOnce = new Promise((resolve) => { releaseWrite = resolve; });
  let writeCalls = 0;
  const manifestStore = {
    ...realManifestStore,
    write: async (...args) => {
      writeCalls += 1;
      if (writeCalls === 1) await stallOnce;
      return realManifestStore.write(...args);
    },
  };
  const s3Config = {
    manifestStore,
    segmentStore: createSegmentStore(store),
    leaseStore: createLeaseStore(store),
    checkpointPolicy: createCheckpointPolicy({ maxWalBytes: 10_000_000, maxIntervalMs: 3_600_000 }),
  };
  const knexA = makeKnex(dbPathA, s3Config);
  await knexA.schema.createTable('widgets', (t) => {
    t.increments('id');
    t.string('name');
  });
  // The local insert itself resolves fast, independent of the stalled ship
  // (that's the whole point of this task) -- awaiting it here does NOT wait
  // for manifestStore.write to unstall.
  await knexA('widgets').insert({ name: 'gizmo' }); // ship stalls on manifestStore.write
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the insert's capture run and its ship reach the stall

  // Call destroy() WHILE the ship is still stalled, and only release the
  // stall afterward -- if destroy() did NOT wait for the pending ship (e.g.
  // its override were missing/removed), `destroyResolved` would flip to
  // true before releaseWrite() runs below, failing the assertion.
  let destroyResolved = false;
  const destroyDone = knexA.destroy().then(() => { destroyResolved = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(destroyResolved, false, 'destroy() resolved before the pending ship settled -- it must wait for it');

  releaseWrite();
  await destroyDone;
  assert.equal(destroyResolved, true);

  // A fresh instance restoring from the same S3 state must see the shipped row —
  // proving destroy()/the next acquire didn't restore before the ship landed.
  const dbPathB = await tmpDbPath();
  const knexB = makeKnex(dbPathB, { ...s3Config, manifestStore: realManifestStore });
  const rows = await knexB('widgets').select('*');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'gizmo');
  await knexB.destroy();
});

test('N sequential awaited inserts are all visible after a restore, even with latent S3 calls (regression: unserialized captures silently dropped writes)', async () => {
  // Regression coverage for a data-loss bug found in code review: without
  // serializing captures per db path, write N+1's capture could run while
  // write N's ship was still in flight and still see the OLD
  // state.lastWalOffset (not yet advanced by N's not-yet-resolved ship), so
  // N+1's captured delta re-included N's already-in-flight frames. N+1's
  // ship then conflicted (CAS overlap) against N's just-landed segment,
  // threw retryTransaction, and the connection was disposed WITHOUT
  // advancing state -- so the next restore silently dropped every write
  // after the first. This needs a store with real latency to reproduce:
  // the plain synchronous in-memory store settles every call before the
  // next statement runs, so the race window never opens.
  const store = withLatency(createInMemoryObjectStore());
  const dbPathA = await tmpDbPath();
  const knexA = makeKnex(dbPathA, makeS3Config(store));
  await knexA.schema.createTable('widgets', (t) => {
    t.increments('id');
    t.string('name');
  });

  const ROWS = 5;
  for (let i = 0; i < ROWS; i += 1) {
    // Each insert is fully awaited -- normal, non-concurrent Ghost usage.
    // The local insert resolves fast (independent of the previous insert's
    // still-in-flight S3 ship, per this task's whole point), so this loop
    // races well ahead of the latency-wrapped ship pipeline and reliably
    // produces overlapping in-flight ships without the serialization fix.
    await knexA('widgets').insert({ name: `gizmo-${i}` });
  }
  await knexA.destroy(); // must drain every in-flight ship before returning

  const dbPathB = await tmpDbPath();
  const knexB = makeKnex(dbPathB, makeS3Config(store));
  const rows = await knexB('widgets').select('*').orderBy('id');
  assert.equal(rows.length, ROWS, `expected all ${ROWS} sequential inserts to survive a restore, got ${rows.length}`);
  for (let i = 0; i < ROWS; i += 1) {
    assert.equal(rows[i].name, `gizmo-${i}`);
  }
  await knexB.destroy();
});

test('SqliteS3Client routes read-only queries to the reader pool, everything else to the writer pool', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const s3Config = { ...makeS3Config(store), readerPoolSize: 2 };
  const knex = knexFactory({
    client: SqliteS3Client,
    connection: { filename: dbPath, s3: s3Config },
    useNullAsDefault: true,
  });
  try {
    await knex.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });
    await knex('widgets').insert({ name: 'gizmo' });

    // A read must not queue behind a held writer-pool connection: acquire
    // the writer connection directly and hold it open, then verify a
    // concurrent SELECT still completes promptly via the reader pool.
    const writerClient = knex.client;
    const heldConnection = await writerClient.acquireConnection();
    try {
      const startedAt = Date.now();
      const rows = await knex('widgets').select('*');
      assert.ok(Date.now() - startedAt < 500, 'read queued behind the held writer connection instead of using the reader pool');
      assert.equal(rows.length, 1);
    } finally {
      await writerClient.releaseConnection(heldConnection);
    }
  } finally {
    await knex.destroy();
  }
});

test('a write is never routed to the reader pool even while it is idle', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const knex = makeKnex(dbPath, { ...makeS3Config(store), readerPoolSize: 2 });
  try {
    await knex.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });
    await knex('widgets').insert({ name: 'gizmo' });
    // Warm the reader pool with an idle connection BEFORE the write this
    // test is really about, so a pass here can't be explained by "the
    // reader pool simply hadn't been used yet" -- it must be that the
    // insert itself genuinely stayed on the writer despite an idle reader
    // connection already sitting in the pool.
    const warmup = await knex('widgets').select('*');
    assert.equal(warmup.length, 1);
    await knex('widgets').insert({ name: 'gadget' });
    const rows = await knex('widgets').select('*');
    assert.equal(rows.length, 2, 'the second insert must be visible to a same-process read — proving it landed on the writer, not on the already-warmed idle reader-pool connection');
  } finally {
    await knex.destroy();
  }
});

// Regression for: restoreLocalDb's atomic rewrite (Task 3) is a
// write-to-temp-then-RENAME, which swaps the directory entry to a brand-new
// inode without touching whatever inode an already-open fd still points at.
// A reader-pool connection opened before a restore keeps reading the OLD,
// now-unlinked inode forever unless something forces it to reopen. This
// matters because a writer reconnect (and therefore a fresh
// acquireRawConnection -> restoreLocalDb) is not a rare event -- it happens
// on every ordinary reconnect after a disposed connection, e.g. any S3 CAS
// conflict surfaced via _shipCapturedDelta. This test forces that exact
// disposal path directly (bypassing the need to engineer a real CAS
// conflict) and verifies a reader-pool connection warmed BEFORE the
// reconnect still sees data written AFTER it.
test('a warmed reader-pool connection is invalidated by a writer reconnect/restore (regression: stale inode after rename)', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const knex = makeKnex(dbPath, { ...makeS3Config(store), readerPoolSize: 2 });
  try {
    await knex.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });
    await knex('widgets').insert({ name: 'first' });

    // Warm a reader-pool connection against the pre-reconnect inode.
    const rowsBefore = await knex('widgets').select('*');
    assert.equal(rowsBefore.length, 1);

    // Force the writer's *next* acquire to reconnect -- and therefore
    // re-run restoreLocalDb, rewriting the local file's inode -- via the
    // same disposal mechanism a real S3 CAS conflict triggers.
    const writerClient = knex.client;
    const heldConnection = await writerClient.acquireConnection();
    heldConnection.__knex__disposed = new Error('simulated disposal for regression test');
    await writerClient.releaseConnection(heldConnection);

    await knex('widgets').insert({ name: 'second' }); // triggers the reconnect + restore

    const rowsAfter = await knex('widgets').select('*');
    assert.equal(
      rowsAfter.length,
      2,
      'a reader-pool connection warmed before the writer reconnected must not keep serving the pre-restore inode'
    );
  } finally {
    await knex.destroy();
  }
});

// Regression for the same stale-inode problem, but via the OTHER path the
// constructor's own comments already document as real: more than one
// independent SqliteS3Client instance pointed at the SAME db path in one
// process (e.g. Ghost's own pool plus a separately-constructed
// knex-migrator pool). Instance A's warmed reader pool must not be left
// stuck on stale data after instance B (a totally separate writer) restores
// the shared file out from under it.
test('two independent SqliteS3Client instances on the same db path: instance A\'s warmed reader sees instance B\'s write (regression: cross-instance stale inode)', async () => {
  const store = createInMemoryObjectStore();
  const dbPath = await tmpDbPath();
  const s3Config = { ...makeS3Config(store), readerPoolSize: 2 };

  const knexA = makeKnex(dbPath, s3Config);
  try {
    await knexA.schema.createTable('widgets', (t) => {
      t.increments('id');
      t.string('name');
    });
    await knexA('widgets').insert({ name: 'from-a' });

    // Warm instance A's reader pool against the current inode.
    const rowsBeforeB = await knexA('widgets').select('*');
    assert.equal(rowsBeforeB.length, 1);

    // A second, independent SqliteS3Client instance on the SAME db path
    // performs its own write -- its own acquireRawConnection restores the
    // shared file (rename to a new inode) completely independently of A.
    const knexB = makeKnex(dbPath, s3Config);
    try {
      await knexB('widgets').insert({ name: 'from-b' });
    } finally {
      await knexB.destroy();
    }

    const rowsAfterB = await knexA('widgets').select('*');
    assert.equal(
      rowsAfterB.length,
      2,
      "instance A's reader pool, warmed before instance B's write, must not keep serving the inode from before B's restore"
    );
  } finally {
    await knexA.destroy();
  }
});
