sqlite-s3's commit path (packages/sqlite-s3/src/commit.js) treats any lost
manifest CAS the same way, whether it lost to a genuinely conflicting
writer or to this same process's own fire-and-forget background checkpoint
(knex-client.js's checkpoint kickoff, I1).

`state.baseline` (knex-client.js:216) is only refreshed from this
connection's own successful commits, never from a checkpoint landing in
the background. Checkpoints fire periodically even with a single writer --
maxIntervalMs defaults to 1 hour (ghost-sqlite-s3-launcher/src/preload.mjs:91).

Sequence:
1. Commit N succeeds, state.baseline set. Checkpoint policy says due,
   fires in background (not awaited).
2. Before the next write, the background checkpoint's CAS lands (new
   baseSegmentId, fresh etag).
3. Commit N+1 starts from the now-stale state.baseline.
4. Its manifest CAS conflicts. commit.js's conflict handler sees
   baseChanged = true (checkpoint always resets baseSegmentId) and
   unconditionally treats this as retryTransaction -- it cannot tell
   "a checkpoint landed" apart from "a hostile conflicting writer."
5. Surfaces as "sqlite-s3: local write committed but lost an
   optimistic-concurrency race shipping to S3 -- this writer's local
   state has diverged from the shared history" (knex-client.js:192), even
   though the "conflicting writer" was this same process's own checkpoint.

Confirmed via logs: a real occurrence happened several hours after the
last redeploy, ruling out redeploy/boot overlap as the cause and matching
the 1-hour checkpoint interval instead. Outcome is safe (connection
disposed, pool reacquires, state restored from S3) but self-inflicted and
alarming to see in logs as if from a second writer.

Fix direction: when the checkpoint kickoff lands successfully, push the
fresh {manifest, etag} into state.baseline before the next commit reads
it, so a same-process checkpoint doesn't masquerade as a conflicting
writer. Needs care around the async/fire-and-forget timing (I1) and the
trxClient-clone caveats already documented in knex-client.js.
