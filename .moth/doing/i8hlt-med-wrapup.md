this is the wrap up task of hi3zi

the goal is full automated cycle - get latest ghost, package, deploy, test, success or rollback.

1. Migration/cutover — extending ssm-backup-instance.sh for content/images/, doing the actual one-time backup-and-restore into the new setup, and switching CloudFront's origin from the EC2 VPC-origin to Lightsail's public endpoint. This is real production work on live infra (a traffic cutover), distinct in kind from "build the image + IaC" (hnj9a) and "implement SQLite-over-S3" (vt4m9) — neither task's description touches it.
2. Real-environment validation — vt4m9 only promises a local Docker smoke test. The credential path (AssumeRole against a live principalArn, the S3-backed SQLite actually working against a real S3 bucket, the SMTP-secret fetch) only exists once deployed to real Lightsail — local smoke testing won't catch it. Worth being explicit this isn't "done" until validated against the deployed thing, not just locally.
3. Credential wiring is split across both tasks and could fall in the crack: hnj9a presumably creates the IAM role + trust policy (IaC), but the app-side AssumeRole call at container startup is really part of vt4m9's runtime code (it needs those temp creds to touch S3). Neither description mentions it explicitly — worth a one-line cross-reference in each so it doesn't get skipped as "the other task's problem."

----- AI agent updates -------

## Decisions (2026-09-08/09)

Prerequisite state: `hnj9a` is done — a real Lightsail deployment was
verified live, then torn down on request. Recreating it from the IaC gives
a fresh, empty setup (no data preserved). Full technical design for the
half decided here:
[docs/superpowers/specs/2026-09-08-phase2-deploy-observability-design.md](../../docs/superpowers/specs/2026-09-08-phase2-deploy-observability-design.md);
implementation plan:
[docs/superpowers/plans/2026-09-08-phase2-deploy-observability-plan.md](../../docs/superpowers/plans/2026-09-08-phase2-deploy-observability-plan.md).
Those hold the technical detail; the decisions themselves are below.

**A deploy is only "successful" if a second, independent layer says so —
the platform's own container health check is not trusted as the signal.**
Getting `hnj9a` live proved that health check untrustworthy in both
directions: it would have passed a container whose credential wiring was
silently broken, and it failed a fully-working container for many rounds
over a health-check-path/URL-subpath mismatch. So the deploy pipeline owns
its own verification.
- Rejected: relying on the platform health check alone — the reason this
  ticket's whole verification layer exists.

**Verification runs entirely outside the container, against the deployed
thing's public surface** — the app's own admin API plus a plain HTTP
check. No change to Ghost, the launcher, or any runtime code.
- Rejected: instrumenting the app or its launcher to self-report health —
  would break the standing "never patch Ghost for this phase's wiring"
  principle, and makes the thing under test its own witness.

**What gets verified: reachability, plus one write-path roundtrip that
creates, reads back, and then deletes a draft with an attached image.**
That single roundtrip is chosen because it exercises the two mechanisms
this phase actually invented and that actually broke — the S3-backed
SQLite write path and S3-backed image storage — while staying
side-effect-free (never published, removed immediately).
- Rejected: read-only checks — would pass against a deployment whose
  writes are broken, which is the exact failure this phase risks.

**Mail is deliberately NOT verified per-deploy.** Accepted, documented
gap: mail regressions have to be caught by a human noticing a real
message never arrived.
- Rejected: sending a real test email each deploy — real side effects on
  a real mailbox, for a lower-frequency, lower-blast-radius failure than
  the DB/storage paths, and never an actual cause of failure so far.

**Two failure modes, handled differently.** If the infra apply itself
fails, the platform has already left the previous deployment serving —
report and stop, there is nothing to roll back. If the apply succeeds but
our own verification fails, that needs an *active* rollback: redeploy the
previous known-good image.
- Rejected: treating both as one generic "deploy failed" path — would fire
  a pointless corrective deploy in the first case.

**Rollback derives "what was live before" from the platform's own
deployment history at run time, never from a local record.** Keeps the
pipeline idempotent and re-runnable, with nothing to drift out of sync
with reality.
- Rejected: a state file (or any local record) tracking the last-good tag.

**Failure is never escalated by guessing.** A rollback that itself fails
is a hard stop with an explicit "manual intervention needed" report — no
second fallback, no retry loop. A first-ever deploy that fails
verification has no previous version to fall back to: say so explicitly
and leave the failing deployment live rather than silently doing nothing.

**The credential the verification needs (an admin API key) is held in the
parameter store and read by the deploy tooling under its own identity.
The container never receives it.** Provisioning that key is a one-time
manual step through the running admin UI, because creating such an
integration is not itself exposed via the API — accepted as a documented
setup step rather than something the pipeline pretends to automate.

**Trigger model: manual, unattended-once-started.** No CI, webhook, or
scheduled trigger, and no steady-state monitoring of the live site after a
deploy succeeds — this covers the deploy moment only.

**Correction (found during planning, before implementation): the
roundtrip's image cleanup cannot go through the admin API** — that API
exposes image upload but no delete. Resolved: the test post is removed via
the admin API as designed, and the test image is removed by deleting the
underlying object in the storage bucket directly, under the deploy
tooling's own identity, using the location the upload response reports.
- Rejected: leaving test images behind — accumulates one per deploy run,
  forever.
- Rejected: adding a delete capability to Ghost itself — violates "never
  patch Ghost for this" for a verification-only need.

## Implementation (2026-09-09)

Built on branch `i8hlt-deploy-observability`. How it's done, abstractly:
the parts carrying real logic (reachability checking, admin-API
authentication and request/response shaping, deriving the previous
deployment's version, deriving a storage object's location from its
public URL) live as small, independently testable units with their
external dependencies injected, so their tests exercise real behaviour
without touching the network or the cloud account. Thin command-line
wrappers expose them, and a single orchestrating script sequences the
whole cycle — build/publish the image, apply the infra, verify, roll back
on verification failure — translating each outcome into a distinct,
diagnosable exit. Operational instructions (how to run it, the one-time
key provisioning, what each outcome means) live in `phase2/readme.md`.

Deliberate testing split, inherited from the design: the logic units are
unit tested; the thin wrappers and the orchestration are not — they are
verified by being run for real, since mocking the cloud would only assert
our own assumptions about it.

**Still open before this ticket is complete:**
- The one-time manual key provisioning described above.
- A real end-to-end run against live infra (currently torn down —
  reapplying recreates it), including deliberately exercising the
  rollback path once rather than only reasoning about it.
- The migration/cutover work in point 1 of the original description
  (backup-and-restore including images, CloudFront origin switch) —
  untouched, still open, and out of scope for the design doc above.
