this is the wrap up task of hi3zi

the goal is full automated cycle - get latest ghost, package, deploy, test, success or rollback.

1. Migration/cutover — extending ssm-backup-instance.sh for content/images/, doing the actual one-time backup-and-restore into the new setup, and switching CloudFront's origin from the EC2 VPC-origin to Lightsail's public endpoint. This is real production work on live infra (a traffic cutover), distinct in kind from "build the image + IaC" (hnj9a) and "implement SQLite-over-S3" (vt4m9) — neither task's description touches it.
2. Real-environment validation — vt4m9 only promises a local Docker smoke test. The credential path (AssumeRole against a live principalArn, the S3-backed SQLite actually working against a real S3 bucket, the SMTP-secret fetch) only exists once deployed to real Lightsail — local smoke testing won't catch it. Worth being explicit this isn't "done" until validated against the deployed thing, not just locally.
3. Credential wiring is split across both tasks and could fall in the crack: hnj9a presumably creates the IAM role + trust policy (IaC), but the app-side AssumeRole call at container startup is really part of vt4m9's runtime code (it needs those temp creds to touch S3). Neither description mentions it explicitly — worth a one-line cross-reference in each so it doesn't get skipped as "the other task's problem."

----- AI agent updates -------

## Decisions (2026-09-08)

`hnj9a` is done (real Lightsail deployment verified live, then torn down
per explicit request — `tofu apply` from `phase2/iac/` recreates it from
scratch, no data preserved). This ticket's "test / success-or-rollback"
half has a full technical design already written:
[docs/superpowers/specs/2026-09-08-phase2-deploy-observability-design.md](../../docs/superpowers/specs/2026-09-08-phase2-deploy-observability-design.md).
Summary: one new `phase2/scripts/deploy.sh` orchestrating the existing
`build.sh` + `phase2/iac/` OpenTofu, adding independent post-deploy
verification (HTTP smoke test + a Ghost Admin API create/read/delete
roundtrip exercising the SQLite-over-S3 write path and S3Storage image
path) and active rollback (redeploy the previous image tag looked up
from Lightsail's own deployment history) on top. Two failure modes
handled differently: `tofu apply` itself failing needs no rollback
(Lightsail leaves the prior deployment ACTIVE); the script's own checks
failing after a successful `tofu apply` triggers the active rollback.
The design doc's own "Out of scope" section is authoritative on what
this pass excludes (notably: the migration/cutover work in this
ticket's point 1, which is separate scope, still open).

**Correction (found during planning, before implementation): image
cleanup in the Admin API roundtrip can't go through the Admin API
itself** — Ghost's `images.js` endpoint only exposes `upload`, no
delete. Resolved: the test post is deleted via the Admin API as
designed; the test image is deleted as a direct S3 `DeleteObject` using
`deploy.sh`'s own AWS identity (same one already used for ECR
login/SSM reads) against the key derived from the upload response's
URL — no new IAM permission needed. Full detail in the design doc's own
"Correction" section.

## Implementation plan

[docs/superpowers/plans/2026-09-08-phase2-deploy-observability-plan.md](../../docs/superpowers/plans/2026-09-08-phase2-deploy-observability-plan.md)


## Implementation outcome (2026-09-09)

The deploy/verify/rollback half is built and reviewed, on branch
`i8hlt-deploy-observability`. Shape: a new `phase2/packages/deploy-verify`
Node package holds the unit-tested pieces (HTTP smoke test, Admin API JWT
signing, Admin API client, previous-deployment-tag parsing, direct-S3
cleanup), each taking an injectable fetch/client so tests never touch the
network or AWS; two thin CLI entrypoints wrap them; `phase2/scripts/deploy.sh`
orchestrates build → apply → verify → rollback. `phase2/readme.md` gained an
operational "Deploying" section (how to run it, the one-time SSM Admin API
key setup, what each outcome means).

Deliberate testing split, carried over from the design doc: the logic is
unit tested, the two CLI wrappers and the bash orchestrator are not — they
are verified by running them for real, not by mocks.

**Not yet done, and required before this ticket is complete:**
- The one-time manual step: create the Ghost Admin API Custom Integration
  through the live admin panel, store its `id:secret` in SSM as
  `ghost_phase2_admin_api_key`. Cannot be automated (integration creation
  isn't itself exposed via the Admin API).
- A real end-to-end run against live Lightsail (infra is currently torn
  down; `tofu apply` recreates it), plus deliberately exercising the
  rollback path once for real.
- The migration/cutover work in point 1 above (backup-and-restore,
  CloudFront origin switch) — untouched, still open.
