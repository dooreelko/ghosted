# sqlite-s3 connection contention fix

moth s0f42

## Problem

Reported: signing in to the blog freezes the whole site. Confirmed in prod
Lightsail logs (2026-09-16, ~07:47-07:51 UTC): sign-in's magic-link verify
request hung 27-30s, and unrelated plain `GET /blog/` requests hung 30s in
the same window. Repeated `Acquire connection error: operation timed out for
an unknown reason` from `tarn` (knex's connection pool), hit by both
foreground page requests and background automation pollers.

Root cause: `sqlite-s3`'s knex pool is pinned to `{min:1, max:1}`
(`phase2/packages/sqlite-s3/src/knex-client.js:39`) — required because
`acquireRawConnection()` deletes and rebuilds the local db file on every
fresh acquire, and a second concurrent connection would race that rebuild.
Every DB operation in the process — every foreground request AND every
background automation poller — therefore serializes through one physical
connection.

Two things compound this into a full freeze rather than just added latency:

1. **Reads queue behind writes for no reason.** `_maybeCaptureCommit`
   (`knex-client.js:106`) is a no-op for reads (no WAL growth to ship), but
   reads still have to wait in the same single-connection queue as writes,
   because there's only one pool.
2. **The connection is held for the S3 round-trip, not just the local
   write.** `_query()` awaits `_maybeCaptureCommit()` before returning
   (`knex-client.js:98-104`), and Knex only releases a connection back to
   the pool once `_query()` resolves. `_maybeCaptureCommit` ships the WAL
   delta to S3 (network PUT + optimistic-concurrency/lease check) — a real,
   unavoidable network round-trip — entirely while holding the exclusive
   connection slot, even though that shipping reads the WAL delta straight
   off disk (`fs.readSync`, `knex-client.js:135-136`) and never touches the
   pooled connection object itself.

The incident window shows these two compounding: a signup (which dispatches
`StartAutomationsPollEvent`, consumed by `poll.js` and
`welcome-email-automation-poll.js`, confirmed via `automations-api.js:291`
gated on `options.event === 'member_sign_up'` — sign-in never dispatches
this) landed seconds before the reported sign-in hang. The signup's cascade
of automation-step writes monopolized the one connection, each write paying
its own full S3 round-trip inline, and the concurrent sign-in's own write
(plus every plain page read) queued behind all of it until the 30s acquire
timeout.

## Non-goals

- Replacing SQLite-on-S3 as the storage architecture (separate decision,
  see moth hnj9a/i8hlt).
- Making automation-poll cascades trigger from anything other than signup
  (confirmed sign-in does not trigger them — no fix needed there).
- General performance tuning beyond removing this specific contention.

## Design

Three changes, in order of how directly each addresses the reported freeze:

### B — Release the connection before the S3 upload finishes (fixes the freeze itself)

`_query()` currently does:
```
result = await super._query(connection, obj)
if (connection.inTransaction === false) await this._maybeCaptureCommit(connection)
return result
```
Restructure so the connection is released back to the pool as soon as the
local write is durable, and the S3 shipping runs after release instead of
gating it:

- `_maybeCaptureCommit` splits into two phases: **capture** (read the WAL
  delta off disk, extract page images — all local disk I/O, needs the
  connection's file to be stable but not the connection object) and
  **ship** (the actual `committer.commitWalDelta()` S3 call).
- `_query()` runs capture synchronously (fast, local-only) before
  returning, but only *schedules* ship (fire-and-forget, same pattern
  already used for checkpointing's `performCheckpoint` in
  `knex-client.js:249`) rather than awaiting it.
- **Ordering constraint:** the next `acquireRawConnection()` (a genuinely
  fresh connection — either at boot or after a disposed/conflicting
  connection) must not run `restoreLocalDb()` while a scheduled ship from
  the previous connection is still in flight, since that ship's outcome
  determines whether `state.lastWalOffset` should advance and whether a
  conflict (`retryTransaction`) needs to mark the connection disposed. Since
  the pool is still `max:1`, there is only ever one physical connection at
  a time — so this means: track one in-flight "pending ship" per
  process (not per-connection, since the connection object may already be
  gone by the time ship resolves) and have `acquireRawConnection()` await
  it before restoring. This preserves current correctness (conflict
  detection, `lastWalOffset` advancement, connection disposal on conflict)
  while letting the *next unrelated query* proceed immediately after local
  commit instead of waiting for this query's own S3 upload.
- Errors from a scheduled ship (including `sqliteS3Conflict`) can no longer
  throw synchronously back to the caller that made the write, since that
  caller has already gotten its response. They get logged and surfaced via
  the same disposal mechanism (`connection.__knex__disposed`) so the next
  acquire still triggers a fresh restore — same recovery path as today,
  just observed one write later.

### A — Separate read pool (stops it spreading to bystanders)

Add a second knex `Client` (reusing `SqliteS3Client`'s file-handling code)
with a real pool (`max: N`, e.g. 4) of read-only connections:

- Opened with `PRAGMA query_only = ON`, pointed at the same on-disk file
  the writer maintains.
- Skip `restoreLocalDb()` on acquire (the writer already keeps the local
  file current; readers just open it) and skip `_maybeCaptureCommit`
  entirely (no writes, nothing to ship).
- Route at the `SqliteS3Client` level: inspect `obj.sql` in the method that
  currently calls `acquireConnection`/`ensureConnection` — `SELECT` (and
  other non-mutating statements) go to the reader pool, everything else to
  the existing single-writer pool. This stays inside the package; no
  changes needed in Ghost core or model code.
- **Safety requirement this depends on:** `restoreLocalDb()`
  (`restore.js:15-17`) currently does `rm` then `writeFile` — a reader
  connection open during that window would see a missing or partially
  written file. Make the restore atomic: write to a temp path alongside
  the target, then `rename()` into place. `rename` on the same filesystem
  is atomic, so readers always see either the old complete file or the new
  complete file, never a torn one. (The `-wal`/`-shm` removal stays as-is —
  those aren't read directly by reader connections opening fresh, since a
  reader's own SQLite handle will create/attach its own view of the WAL
  once it opens the renamed `.db` file under WAL mode.)

### C — Fail fast instead of hanging (safety net)

Lower the pool's `acquireConnectionTimeout` from whatever currently yields
~30s down to something short enough to fail visibly (e.g. 5s) paired with
a bounded retry/backoff at the call site instead of a bare throw, so any
*residual* contention (e.g. a real burst of concurrent writers even after B)
degrades to a quick retry-able error instead of a 30-second hang. This is
explicitly a fallback for cases A+B don't fully absorb, not the primary fix.

## Error handling

- Scheduled (post-release) ship failures: logged, connection marked
  disposed so next acquire restores fresh — no change in eventual
  consistency guarantees, only in when the failure is observed relative to
  the request that caused it.
- Reader-pool queries never mutate, so a reader hitting a stale/mid-swap
  file is prevented structurally (atomic rename) rather than needing
  runtime error handling.
- C's fast-fail applies uniformly to both pools' acquire paths.

## Testing

- Unit: `_maybeCaptureCommit` split into capture/ship — verify capture
  still correctly identifies commit boundaries and trims orphaned
  rolled-back frames (existing behavior, must not regress); verify ship
  scheduling doesn't advance `lastWalOffset` until ship actually succeeds
  (existing conflict-safety invariant, must not regress).
  and
- Unit: `restoreLocalDb` atomic swap — verify a reader that opens the file
  mid-restore never observes a missing or truncated file (race test:
  concurrent restore + open loop).
- Integration: reproduce the incident shape — one connection doing several
  sequential writes (simulating a signup's automation cascade) concurrently
  with a plain read and a sign-in-shaped write; assert the read returns
  immediately (not queued behind the writes) and the concurrent write
  completes within one write-latency, not N.
- Manual: after deploy, replay the same concurrent signup+signin pattern
  against a staging Lightsail deployment and confirm no 30s hangs in logs.

## Rollout

Ship as one deploy via the existing `phase2/scripts/deploy.sh` pipeline
(see `.local-secrets.md` "Ghost Custom Build Deploy Pipeline"). Every file
this plan changes lives under `phase2/packages/*`, which only reaches
production through the phase2 Docker image build/deploy path — not the
phase1 Lightsail-instance ghost-cli path (`phase1/scripts/ssm-deploy-ghost-update.sh`),
which is unrelated to this work. The phase2 Docker image COPYs whole
package directories (no `files` whitelist), so the new `reader-client.js`
and `restore-generation.js` modules ship automatically with no separate
step. No DB migration, no schema change — pure connection-handling
behavior inside `sqlite-s3`.
