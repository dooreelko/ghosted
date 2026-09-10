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


## Migration/cutover decisions (2026-09-09)

Covers point 1 of the original description, previously untouched. Full
technical design:
[docs/superpowers/specs/2026-09-09-phase2-migration-cutover-design.md](../../docs/superpowers/specs/2026-09-09-phase2-migration-cutover-design.md).

**Infrastructure comes up in stages, behind two flags** (both default
off): nothing set deploys the prerequisites (data bucket, image
registry); one flag adds the container service and everything that can
only be expressed once it exists; the second repoints the CDN at it.
Staging matters because the backup and seeding steps need the bucket to
exist long before there is anything to run.
- The app's runtime role sits under the container-service flag, not with
  the prerequisites: its trust policy names the service's own principal,
  and that attribute cannot be filled in later — the role is
  unexpressible without the service and meaningless before it. Rejected:
  keeping it with the prerequisites behind a placeholder trust policy,
  which is either invalid or a security regression.
- Asking for the CDN flag without the service flag fails before anything
  is applied: there would be no origin to point at.

**The CDN distribution is adopted into this phase's IaC rather than left
hand-managed** — but only through an empty-plan gate: describe the
existing distribution, iterate until a plan reports no changes at all,
and only then wire the flag. The gate is the safety mechanism; it means
the live configuration is never guessed at. The distribution is also
marked undeletable, because destroying this phase's stack was routine
during `hnj9a` and this one distribution serves the whole site, not just
the blog.
- Rejected: switching the origin with a script and leaving the CDN out of
  IaC — smallest blast radius, closest to how phase 1 is operated, but
  gives up the declarative flag and leaves cutover state untracked.
- Rejected: standing up a second distribution and moving DNS — cleanest
  end state, but reproduces the root site's origins, behaviours and
  certificate for no current benefit, and makes rollback wait on DNS
  instead of a behaviour flip.

**The old instance is upgraded first, then its database is taken.** The
migrated database must land on a Ghost that runs no schema migrations on
first boot, so that any difference between source and result is a real
fault rather than an expected upgrade artifact. Upgrading happens on the
old instance, where it is a rehearsed operation with an existing rollback
script, and is verified healthy before anything is copied.
- Rejected: building the new setup at the old version instead — leaves
  the upgrade as unfinished business immediately after a cutover.
- Rejected: letting the new setup migrate the database on first boot —
  the schema then legitimately differs, so validation weakens to
  content-level comparison, and any fault means debugging new
  infrastructure and a version jump at once.

**Both sides build from stock upstream; the local-patches branch is
retired.** All of this phase's wiring lives in the launcher, so no Ghost
source is patched. The one carried patch is not currently effective, so
there is nothing to preserve; reintroducing it belongs to `syigu`. One
commit is pinned at cutover time and used for both the old instance's
upgrade artifact and the new image.
- Rejected: merging upstream into the patched branch and building both
  sides from it — preserves a patch that does nothing, at the cost of a
  conflict-heavy merge and a permanently diverged branch.

**The database snapshot is taken with an online-safe copy, not a file
copy** — the source is live, and copying it directly yields a torn
snapshot plus a separate write-ahead log.

**Images are synced from the instance directly to their final location**
in the data bucket, so the image migration is that one sync. Rejected:
the existing chunked-transfer script (caps out well below the ~15MB of
content, as `hi3zi` found) and tar-then-unpack staging (buys nothing).
- The storage prefix is set so the public path maps 1:1 onto the stored
  key, leaving rendered URLs unchanged. Rejected: an edge function
  rewriting the request path — an extra moving part and failure mode for
  the same mapping.

**Seeding refuses to overwrite.** A tool turns a plain database file into
the store's initial state, writing the root pointer conditionally on it
not already existing — so seeding a store that already holds data fails
outright. Deliberately no force flag: clearing a store should be a
separate, explicit act. Its inverse (reading a plain database back out)
is built alongside, because validation needs it and because without it
there is no way to recover a readable database from the store at all.

**Validation is a hard gate before traffic moves**, run against the new
setup's own endpoint. It compares the source database against the
post-boot one — not byte-wise, since the application mutates state on
boot regardless — using row counts everywhere plus content checksums on
the tables that carry posts, users, tags and members, against an
**explicit allowlist of what may legitimately differ**. Anything outside
that list fails. The allowlist is the point: it turns "what changes on
boot" into a reviewable statement instead of a judgement call made under
pressure. Alongside it, a content check walks recent posts through the
admin API and confirms every referenced image actually resolves — the
only check that catches a broken image path — and a short human look at
a few pages.

**Cutover order and reversibility**: upgrade and verify the old instance;
apply prerequisites; take the final backup (the accepted downtime window
starts here — anything written afterwards is lost); seed; deploy the
container service and validate against its own endpoint; only then flip
the CDN; re-validate on the real domain. Everything before the CDN flip
is inert. Rollback is flipping it back — the old instance keeps serving
its own untouched database throughout, and since the distribution and DNS
never change identity, recovery takes minutes rather than a propagation
wait. The cost of rolling back is any content written to the new setup
after cutover; stated, not silent.

**Out of scope**: decommissioning the old instance (it stays as the
rollback target), reintroducing any Ghost source patch, steady-state
monitoring, and any DNS or certificate change.


## Decisions forced by executing the cutover (2026-09-10)

The cutover was performed. What follows are decisions that only became
visible by running it against the real systems; each corrects or extends a
decision above rather than replacing the feature.

**Version alignment is achieved by pinning the new system DOWN to the old
one's version, not by upgrading the old one first.** The requirement is
unchanged — the migrated database must boot with no schema migrations, so
that any difference the validation reports is a real fault. But the earlier
decision assumed a stale source. In fact the source was one release behind
current, while the fork's mainline carried a *prerelease* version number, so
building from mainline would have put a release candidate into production.
Pinning the new build to the version the source already runs satisfies the
requirement with no production upgrade in the cutover window at all.
- Rejected: upgrading the source first (the earlier decision) — buys being
  current at the cost of a production upgrade inside the window, and would
  have shipped a prerelease.
- Consequence, accepted: the site is one release behind on cutover day.
  Upgrading afterwards is ordinary maintenance, no longer migration work.

**Uploaded themes are content and must be carried across; they are baked
into the image.** The backup's original scope called themes "software,
reinstallable". That holds for the themes the platform ships (they are
symlinks into its own install) and is false for any theme uploaded through
the admin panel, which exists only as a directory in the source's content.
The database names an active theme and the app refuses to render the
frontend when it is absent: the first migrated boot served the admin panel
correctly and returned an error page to every visitor.
- Rejected: restoring themes from object storage at boot — consistent with
  how the database is handled, but adds a failure mode to the boot path.
- Rejected: switching the site to a shipped theme — changes how the site
  looks to avoid solving the problem.
- Consequence, accepted: a theme uploaded through the admin panel afterwards
  lives only in that container and is lost on the next deploy. Changing
  themes is now a commit-and-rebuild.

**The CDN must not forward the Host header to the container origin.** The
container platform routes by Host; given the site's own domain it matches no
service and returns 404. Forwarding Host was correct for the old VM origin,
whose reverse proxy keyed on it, and became wrong the instant the behaviours
moved. This took the blog down for several minutes during the cutover, with
images (served from object storage, not the container) still fine — the
asymmetry is the diagnostic. The origin-request policy therefore follows the
cutover flag, so each origin gets the treatment it needs.

**The snapshot tool must not assume a database CLI on the source host.** The
source had none, and installing a package on a production instance merely to
take a backup is the worse trade: the snapshot is taken through the database
library the application itself already vendors, which is present by
definition. The integrity check must assert its *output*, since it reports
corruption as result rows while still succeeding as a query.

**Anything crossing the constrained management channel is compressed
first.** That channel carries payload as text in command output, chunked, so
cost is linear in size — a database that compresses well should not be sent
raw. (The chunked transfer also had a latent defect that only appears past a
certain size; it now pins the chunk-naming width on both sides.)

**Emptying the store is an explicit act, and it gets a tool.** The seeder
refuses to overwrite an existing store and has no force flag, deliberately.
The runbook then told the operator to empty it and offered nothing to do it
with, which under time pressure means hand-deleting objects from a bucket
that also holds the migrated images. The tool defaults to a dry run and
never touches images.

**The boot-mutation allowlist needs column granularity, not just table and
setting granularity.** Observed: exactly one column of one row moved on
boot — an activity timestamp the app stamps when it sees a visitor.
Allowlisting that whole table would have exempted the audience list from
comparison entirely, so losing members would go undetected. Naming the
volatile column keeps every other field of every row under the checksum.
- Consequence: like the settings allowlist, entries are added only from an
  observed boot, each with a note saying what moved and why it is not
  content.

**Create the deploy-verification integration on the SOURCE system before
the final snapshot.** Its credentials live in the database, so an
integration created on the new system is destroyed by the next re-seed.
Created on the source, it migrates across and the deploy pipeline works
from the first deploy. A further reason: the admin panel refuses browser
logins whose origin does not match the configured site URL, so the new
system's admin panel is not reachable by hostname before cutover anyway.

## Outcome

Executed end to end on 2026-09-10. The migrated database booted on the
object-store-backed database and served the real site; validation passed
both before the traffic move (checking images directly in the bucket) and
after it (checking them over HTTP through the CDN); no content was lost, the
source's counts and timestamps being identical to the snapshot at flip time.
The old instance is kept as the rollback target.

**Known, accepted, and tracked elsewhere**: checkpointing in the
object-store-backed database never lands — see `zwx7x`, which blocks closing
this ticket. It does not corrupt anything, but the store accumulates
orphaned data and the boot-time restore grows without bound, so it is now a
live production concern rather than a theoretical one.

## Blocking zwx7x resolved, and a real end-to-end deploy run executed (2026-09-10)

`zwx7x` (checkpoint race fix, plus a follow-up monitoring ticket `rk2qo`)
is done — see those tickets for their own decision records. This unblocks
this ticket's own still-open item from the Implementation section: "a real
end-to-end run against live infra."

Deploying zwx7x/rk2qo's work required merging `i8hlt-deploy-observability`
into that work's branch first: this ticket's `phase2/iac/` (with the
CloudFront cutover state) was the only copy matching what is actually live
— the other branch, based on `main`, had never seen the cutover and would
have tried to recreate the whole stack from scratch against the real
account. Merged cleanly.

**Running `phase2/scripts/deploy.sh` for real, for the first time, found
two bugs this ticket's own testing section had flagged as an accepted risk
("verified by being run for real") — both now fixed:**

- The script never passed `deploy_cloudfront=true` to `tofu apply`. That
  was correct when written (cutover was still a future, separate, explicit
  apply, and a routine deploy must never move public traffic) but became
  wrong the moment the cutover actually happened and made `deploy_cloudfront`
  part of the live, permanent state — every routine deploy since would have
  tried to revert it to the `false` default. It got partway through
  destroying the live origin access control before AWS's own
  `OriginAccessControlInUse` guard rejected the delete — no actual damage,
  but the failure mode is now closed rather than merely dodged once. This
  is a **correction to the Migration/cutover decisions section above**, not
  a new decision: the flag's role changes from "the cutover switch" to
  "must match already-live state" the instant cutover completes, and the
  deploy tooling has to track that transition.
- `deploy-verify`'s Admin API image upload never set a MIME type on the
  multipart file part, which a real Ghost server rejects — invisible to
  the unit test's mocked fetch, exactly the gap the design doc predicted
  ("mocking the cloud would only assert our own assumptions about it").

**Outcome of the real run**: the Lightsail deployment itself succeeded and
went ACTIVE (the platform's own health check passed) despite the pipeline
script reporting overall failure — the CloudFront-side bug above caused
the script's own exit code and message to be misleading ("Lightsail
rejected the new version," which is not what happened). Verification
(smoke test + Admin API roundtrip) was then run manually against the live
service and passed cleanly after the MIME-type fix. This is the first real
evidence this ticket's verification layer actually works end to end
against the deployed thing, not just in unit tests.

**Still not done, from the original testing section**: the rollback path
itself has still never been deliberately exercised for real (only reasoned
about, and now once accidentally *not* triggered because the underlying
deployment actually succeeded). Whether to deliberately force a bad deploy
to exercise it is an open question for whoever decides this ticket is
complete.


## Incident: the real deploy run broke every image on the site (2026-09-10)

Direct consequence of the `deploy_cloudfront=true` bug recorded above.
Before that bug was fixed, the real `deploy.sh` run got far enough into
its flawed `tofu apply` to actually delete `aws_s3_bucket_policy.data_cloudfront_read`
— the policy that lets CloudFront's origin access control read the images
bucket. The sibling `aws_cloudfront_origin_access_control` resource
survived only because AWS itself refused that specific delete
(`OriginAccessControlInUse`, since the distribution still referenced it);
the bucket policy had no equivalent protection and was removed cleanly.
Every image on the live site started returning 403 from that point,
silently — the deploy pipeline's own verification step never ran against
this deployment (it errored out earlier, on the unrelated OAC failure),
so nothing caught it. Found only because a user noticed a broken image
and reported it. Fixed with a second, targeted `tofu apply` restoring
just that one policy (confirmed via plan: 1 to add, 0 to change, 0 to
destroy) — full image serving confirmed restored within minutes.

**This also exposed a real design gap in the verification layer itself,
not just the one-off deploy.sh bug.** The Design decisions section above
says the roundtrip "exercises... S3-backed image storage" — true only for
the *write* path: `uploadImage` writes directly to S3 under the app's own
runtime role, which needs no CloudFront/OAC/bucket-policy permission at
all. Nothing in the roundtrip ever fetched the uploaded image over its
real public URL, so a regression that breaks only the CloudFront *read*
path (exactly this incident) was structurally invisible to it — the
roundtrip would have kept reporting `{"ok":true}` throughout the outage.
Fixed: the roundtrip now fetches the uploaded image's real URL through the
CDN and fails if it isn't a 200, before proceeding to the rest of the
check. This is a **correction to the Design decisions section's stated
verification coverage**, not a new decision — "one write-path roundtrip"
needed a public-read check alongside it to actually cover what it claimed
to cover.
