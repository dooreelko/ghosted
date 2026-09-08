# Phase 2 Deploy Observability & Rollback — Design

> Moth ticket: `i8hlt` (Wrapup, subtask of `hi3zi`)

## Purpose

`hi3zi`/`i8hlt` calls for "a full automated cycle: get latest ghost,
package, deploy, test, success or rollback." This spec covers the
**test / success-or-rollback** half specifically — what "the deploy
succeeded" should actually mean for this stack, and how to detect and
act on failure.

The need is not hypothetical: getting `hnj9a`'s Lightsail deployment
live this session took an extended debugging session because Lightsail's
own container health check was, at different points, both **too
lenient** (would have reported success while AssumeRole/S3 credential
wiring was silently broken, if the specific bug order had been
different) and **too strict in a way that hid a real success** (a
health-check-path/`GHOST_URL`-subpath mismatch made a fully-booted,
correctly-serving container look permanently unhealthy for many rounds).
Lightsail's health check alone is not trustworthy signal either way —
this spec builds a second, independent layer of verification the deploy
script controls directly.

## Architecture

One new script, `phase2/scripts/deploy.sh`, orchestrating the existing
`phase2/docker/build.sh` and `phase2/iac/` OpenTofu config, adding its
own post-deploy verification and rollback on top. No changes to the
Ghost fork, the launcher, or the app's runtime code — verification is
done entirely from *outside* the container, using Ghost's own existing
Admin API plus a plain HTTP smoke test. This keeps the "never patch
Ghost for the sqlite-s3 wiring" principle intact; observability is a
deploy-time concern, not a runtime one.

### Two independent failure modes

The core design insight, directly drawn from this session: a deploy can
fail in two qualitatively different ways, and they need different
responses.

1. **`tofu apply` itself fails** — Lightsail's own health check rejects
   the new deployment version. Lightsail has *already* left the previous
   deployment ACTIVE and serving (confirmed behavior, observed
   repeatedly this session: a failed deployment version never disturbs
   the currently-active one). There is nothing to roll back — the script
   reports the failure and exits non-zero. Attempting a corrective
   `tofu apply` here would be redundant at best.

2. **`tofu apply` succeeds, but the script's own checks fail** — Lightsail
   is satisfied, the script is not. This is the gap this session's
   saga exposed in the abstract (a container Lightsail is happy with can
   still be broken in ways that matter — credentials, DB, mail, image
   storage). This case needs an *active* rollback: redeploy the previous
   known-good tag via a fresh `tofu apply`.

### Pipeline steps

1. **Build & push** — `build.sh` (unchanged, already exists): builds the
   two-stage image, tags it by git short-SHA, pushes to ECR. Its existing
   dirty-tree guard already ensures the tag uniquely identifies the
   committed source.
2. **Deploy** — `tofu apply -auto-approve -var image_tag=<new-sha>`.
   OpenTofu's own wait blocks on Lightsail's health check
   (`phase2/iac/deployment.tf`). Non-zero exit here is failure mode 1:
   stop, report, exit non-zero. No rollback action needed.
3. **HTTP smoke test** — `curl` the real public Lightsail URL's site
   path (`/blog/`) and admin panel path (`/blog/ghost/`), expect 200 on
   both. Cheap, catches gross reachability problems (the health-check-path
   class of bug, from the outside, the way the health check itself
   should have).
4. **Admin API roundtrip** — using a one-time-provisioned Ghost Admin API
   key (see "Admin API key provisioning" below): create a draft post
   with one small test image attached, read it back, then delete both.
   This single roundtrip exercises the full SQLite-over-S3 write path
   (create — the exact operation that failed repeatedly this session)
   **and** the S3Storage image-upload path, in one side-effect-free
   operation (draft, never published; deleted immediately after).
5. **On failure of step 3 or 4**: look up the previous ACTIVE
   deployment's image tag directly from Lightsail's own deployment
   history (`aws lightsail get-container-service-deployments`, the
   entry before the one just created) — no separate state file to drift
   out of sync with reality — and `tofu apply -var image_tag=<previous>`
   to roll back. Report which tag ended up live and why.
6. **On full success**: report which tag is live and that both checks
   passed.

### Admin API key provisioning

A dedicated Ghost Admin API "Custom Integration" is created once,
manually, through the admin panel (a one-time setup step, not part of
the automated pipeline — creating integrations isn't itself exposed via
the Admin API). Its `id:secret` pair is stored in SSM Parameter Store as
a `SecureString`, following the exact pattern already established for
the mail credential (`ghost_imap_token`): a new parameter,
`ghost_phase2_admin_api_key`, read only by `deploy.sh` running
externally — the
**container itself never receives or needs this credential**, only the
deploy script does, using its own AWS identity (not the container's
AssumeRole path) to fetch it from SSM.

### Explicitly accepted gap: mail is not verified per-deploy

Sending a real test email on every deploy has real side effects (a real
message hits a real inbox) and mail misconfiguration is lower-frequency
and lower-blast-radius than a broken DB or image-storage path — it was
never the actual cause of any bug this session, unlike the DB/write
path. This is a deliberate, documented gap, not a silent omission:
mail-wiring regressions would have to be caught by a human noticing a
real failure (e.g. a comment-notification email never arriving), not by
this pipeline.

### Correction (pre-implementation): image cleanup can't go through the Admin API

Ghost's Admin API has no image-delete endpoint (`images.js` only exposes
`upload`, confirmed by reading Ghost's own endpoint controller) — "delete
both" in step 4 is not literally achievable via the Admin API alone.
Resolved: the post is deleted via the Admin API as planned; the test
image is deleted as a direct S3 `DeleteObject` call, using `deploy.sh`'s
own AWS identity (the same one already used for ECR login / SSM reads),
against the key derived from the URL the upload response returns (the
bucket is `SQLITE_S3_BUCKET`, already known to the deploy script). No new
IAM permission needed beyond what an operator's AWS identity already has.
- Rejected: leaving the test image in S3 permanently — would accumulate
  one object per deploy run indefinitely.
- Rejected: adding an image-delete capability to Ghost itself — would
  violate the "never patch Ghost for this" principle for a
  verification-only need.

## Error handling

- Every step's failure is reported with enough detail to diagnose
  without re-running: which step failed, the exact command's output,
  and (for rollback) which tag ended up live.
- The rollback's own `tofu apply` can itself fail in principle (e.g. if
  the previous tag's image was somehow deleted from ECR since). This is
  treated as a hard stop, not a further auto-retry loop — the script
  exits non-zero with an explicit "rollback also failed, manual
  intervention needed, currently-live tag is X" message. Never guesses
  further or attempts a third tag.
- The script is idempotent to re-run: it always re-derives "current"
  and "previous" state from Lightsail's own deployment history at the
  start of each run, never from a stale local file.
- **First-ever deploy has no "previous" tag to roll back to.** If steps
  3/4 fail on a deployment with no prior ACTIVE version in Lightsail's
  history, the script reports this explicitly (not a silent no-op) and
  leaves the new, failing deployment live — there is nothing safer to
  fall back to.

## Testing

- `build.sh`'s existing behavior (dirty-tree guard, image build/push) is
  unchanged and already has real-world verification from this session.
- `deploy.sh`'s smoke-test and Admin-API-roundtrip logic should get a
  local/mocked test pass (verifying request construction and
  response-parsing logic) plus at least one real, hands-on end-to-end
  run against the actual Lightsail deployment before this is considered
  done — matching this project's established practice of not trusting
  local-only verification for anything touching real AWS credentials or
  the real deployed environment (the same lesson `hnj9a`'s own ticket
  already states about `vt4m9`'s local-only smoke test).
- The rollback path specifically should be exercised for real at least
  once (deliberately deploy a broken tag, confirm the script detects it
  and rolls back correctly) rather than only reasoned about.

## Out of scope (for this spec)

- The migration/cutover work itself (backup-and-restore,
  `ssm-backup-instance.sh` extension, CloudFront origin switch) — already
  scoped by `i8hlt`'s existing ticket text, unaffected by this spec.
- Any change to trigger model beyond "manual trigger, unattended
  pipeline" — no cron/webhook/CI integration is being built now.
- Scheduled/continuous monitoring of the live site after a deploy
  completes successfully (e.g. an ongoing synthetic uptime check) — this
  spec covers the deploy moment itself, not steady-state monitoring.
