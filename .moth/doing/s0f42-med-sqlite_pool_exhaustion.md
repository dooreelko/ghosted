seems like sqlite hangs on parallel(?) requests

----- AI agent updates -------

## Root cause (confirmed via prod logs, 2026-09-16)

`sqlite-s3`'s knex pool is pinned to `{min:1, max:1}` by design (SQLite file
safety — see comment at `phase2/packages/sqlite-s3/src/knex-client.js:39`).
Every DB access in the process — foreground requests AND background
automation pollers (`poll.js`, `welcome-email-automation-poll.js`) —
serializes through that one physical connection. When something holds the
connection too long, every other caller queues on `tarn`'s acquire and times
out at ~30s. Observed in Lightsail container logs:

- Sign-in (magic-link flow) and even plain `GET /blog/` hanging ~30s, "site
  frozen" for the reporting user.
- Repeated `Acquire connection error: operation timed out for an unknown
  reason` from `tarn/dist/PendingOperation.js`, hit both by page requests and
  by the background automation pollers.
- An earlier related symptom: `sqlite-s3: local write committed but lost an
  optimistic-concurrency race shipping to S3` on a background job update —
  same single-connection contention surface, different manifestation.
- Container restarts (Lightsail health check failing under the sustained
  30s+ latency) temporarily clear the backlog; contention re-accumulates
  under load. Not a crash-loop from a code exception — it's queuing
  behind one serialized connection.

Confirmed via incident replay in logs: the trigger wasn't sign-in cascading
its own writes (checked — automation pollers only fire on `member_sign_up`,
never sign-in) but plain concurrent-write contention: a signup's automation
cascade held the single writer connection through several sequential S3
uploads while a concurrent sign-in's own write, and unrelated plain page
reads, queued behind it past the 30s acquire timeout.

Out of scope for the fix decision (needs to stay out of the fix, not
re-litigated): re-architecting away from SQLite-on-S3 entirely — Phase 2's
storage choice is a separate decision (see moth hnj9a/i8hlt) and not what
this ticket is about.

## Decision (2026-09-16)

Decided fix, three parts (full design:
`docs/superpowers/specs/2026-09-16-sqlite-s3-connection-contention-design.md`):

- **B (primary fix):** release the pooled connection back as soon as the
  local write commits; run the S3 upload after release instead of holding
  the connection through it. This is what actually stops sign-in (or any
  write) from queuing behind another write's S3 round-trip.
- **A:** separate read-only connection pool so page reads never queue
  behind writes at all (requires making `restoreLocalDb`'s file rewrite
  atomic via rename, so a reader never observes a mid-restore file).
- **C:** lower acquire timeout + fast retry as a safety net for any
  residual contention, not a substitute for B.

Explicitly rejected: throttling/decoupling automation pollers from their
trigger event — investigated and ruled out, since they don't fire on
sign-in at all; nothing there to decouple.

Spec written and committed, awaiting user review before implementation
plan (writing-plans skill) is drawn up. Not yet on a feature branch — no
implementation started.


## Implementation complete (2026-09-16)

Branch `s0f42-sqlite-pool-exhaustion`, implemented via subagent-driven-development
(plan: `docs/superpowers/plans/2026-09-16-sqlite-s3-connection-contention.md`).
All 6 plan tasks landed and passed review (two real Critical concurrency bugs
were caught by review and fixed before merge — unserialized ship pipeline
causing silent write loss, and reader-pool connections pinned to stale
pre-restore inodes). Final whole-branch review clean after one fix wave
(acquire-timeout default raised 5000ms→15000ms per observed prod restore
metrics up to 7.4s; spec's Rollout section corrected to the actual phase2
deploy pipeline). Full detail and every ruling made along the way is in
git history on the branch — not duplicated here.

Two follow-on hardenings added after the main fix, same branch:

- `phase2/scripts/deploy.sh` now runs the sqlite-s3 e2e suite (including the
  incident reproduction) as a precondition gate before every deploy.
- `phase2/packages/deploy-verify`'s post-deploy check now completes a real
  sign-in via the 6-digit one-time-code path (the exact flow that froze in
  the incident) against `robots@the-well-architected-cloud.com`, deriving
  the code from the DB (token row + `members_otc_secret` setting) via the
  same HOTP algorithm Ghost core uses — no email reading required. Previously
  this check only confirmed the sign-in email was *sent*, not that sign-in
  actually completed.

Not run `moth done`/`moth start` — awaiting review/merge decision.


## Post-implementation regression found and fixed (2026-09-16)

Real deploy (Lightsail deployment 12, then 13) crash-looped on every boot:
`Unable to acquire a connection` from `ReaderClient` (Task 4's reader pool).
Not caught by any unit/e2e test or review pass — root cause needed live
prod diagnostics (no SSM/shell access to the Lightsail container; iterated
via temporary diagnostic logging + redeploy instead).

Root cause: Ghost core's `Settings.populateDefaults()`
(`core/server/models/settings.js:355`, comment: "this is required for
sqlite to pick up the columns after db init") does `await
ghostBookshelf.knex.destroy(); await ghostBookshelf.knex.initialize();` on
the SAME shared knex instance as a documented reconnect, not a final
teardown. knex's public `initialize()` calls `client.initializePool(config)`
directly, and base `initializePool` only ever rebuilds the WRITER's own
pool — it has no knowledge of `_readerClient`, Task 4's own addition.
`destroy()` correctly tore the reader down too, but nothing ever revived
it, so every read routed to the reader pool for the rest of that process's
life threw the same error.

Fixed by overriding `initializePool` (not `initialize` — that's the wrong
method, confirmed by tracing knex's own `make-knex.js`) to also
reinitialize `_readerClient`'s pool, guarded to no-op on the writer's own
construction-time call. Reproduced locally by mirroring Ghost core's exact
`destroy()+initialize()` sequence in a new regression test — confirmed red
without the fix, green with it. Diagnostics that pinpointed this were
temporary and removed once root-caused.

Deployment 13 was the failed attempt with diagnostics; the real fix has
not yet been deployed as of this note. Old version (11) has been serving
throughout — no user-facing outage from this regression, only a blocked
deploy pipeline.


## Deploy pipeline shakeout (2026-09-16, continued)

Real deploy confirmed the sqlite-s3 fix itself is good: deployment 14
(tag `90fb07e`, includes the destroy()+initialize() reader-pool fix) booted
clean, no crash, currently ACTIVE and serving. Two separate bugs surfaced
in the surrounding deploy tooling during this same run, both fixed and
tested:

1. `otc-signin-smoke.mjs`'s `send-magic-link` request never set
   `includeOTC: true` — Ghost core silently never returns `otc_ref`
   without it (no error). Every deploy that reached verification would
   fail this check.
2. `findPreviousTag` picked the second-newest deployment by version number
   with no regard for `state`, so a rollback after this could land on an
   earlier FAILED deployment's tag instead of the last one that actually
   served traffic — confirmed: it picked deployment 13's tag (an old
   diagnostic-only build), which crash-looped the same way and made the
   rollback itself fail too. Now skips FAILED deployments.

Neither bug touched the sqlite-s3 fix. Fixes committed, not yet deployed.
