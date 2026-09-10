Publish custom CloudWatch metrics from the phase2 container's own runtime
identity (already assumes an IAM role for S3) rather than relying on
Lightsail's limited built-in logs/metrics, and alarm on the specific
failure modes zwx7x's checkpoint-race fix left as monitored-but-not-fully-
closed risk.

## Metrics (per boot, from ghost-sqlite-s3-launcher/src/preload.mjs)

- OrphanedSegmentCount: a dry-run reclaimOrphanedSegments() call, published
  once at boot. Direct signal for the original bug's failure mode recurring.
- RestoreRetryCount: how many times restoreLocalDb had to re-read the
  manifest and retry (the TOCTOU fix from zwx7x). Nonzero means that race
  actually fired in production.
- RestoreDurationMs: wall-clock time for the boot-time restore. Early
  warning for the other parked risk (lease.refresh() is implemented but
  never called; a slow restore could outrun the fixed 5-minute lease TTL).

## Alarms

Three aws_cloudwatch_metric_alarm resources (OrphanedSegmentCount > 0,
RestoreRetryCount > 0, RestoreDurationMs > 150000ms i.e. half the lease
TTL), all treat_missing_data = notBreaching since boots are irregular.
New SNS topic + email subscription (robots@the-well-architected-cloud.com).

## Accepted gap

Per-boot cadence means a leak during a long uptime with zero restarts
won't be caught until the next restart. Mitigated by tcho2's weekly
auto-update restart (ticket exists, not yet implemented) -- documented
here as a known limitation, not a silent gap.

## Out of scope

CheckpointOutcome metrics (checkpoint success/abandon counts) -- deferred,
not part of this ticket. Automated deploy pipeline integration -- deploy
here is manual (tofu apply by hand); the automated pipeline is i8hlt-only
and unmerged.

Full design: docs/superpowers/specs/2026-09-10-checkpoint-monitoring-design.md

## Implemented and deployed (2026-09-10)

Code (sqlite-s3: restoreLocalDb stats + onRestoreComplete hook; launcher:
metrics.mjs + preload.mjs wiring) and IaC (monitoring.tf: SNS topic +
subscription + 3 alarms; iam.tf: cloudwatch:PutMetricData) built on
zwx7x-checkpoint-race-fix, TDD throughout.

Deploying required merging i8hlt-deploy-observability into that branch
first -- its phase2/iac/ was the only one matching real deployed
infrastructure (this branch's own iac/, based on main, had an empty local
tfstate and would have tried to recreate everything from scratch against
the real account). Merged cleanly (2 minor conflicts, resolved).

`tofu apply` for the monitoring resources alone was clean (5 added, 1
changed, 0 destroyed) once run with the correct current variables
(deploy_lightsail=true, deploy_cloudfront=true, image_tag matching the
live deployment) -- live infra confirmed applied.

Running `phase2/scripts/deploy.sh` (the actual code deploy) surfaced a
real, pre-existing bug on i8hlt: the script never passed
`-var deploy_cloudfront=true`, so it attempted to revert the already-live
CloudFront cutover back to its `false` default -- it got partway through
destroying the in-use origin access control before AWS's own
OriginAccessControlInUse guard rejected the delete. No actual damage, but
the underlying Lightsail deployment itself succeeded and went ACTIVE
(image `91f0a98`, containing this session's full code) despite the
script's own misleading "Lightsail rejected the new version" failure
message. Fixed deploy.sh to pass deploy_cloudfront=true explicitly on
both its apply calls (primary and rollback).

Also found and fixed, while manually verifying the live deploy: deploy-
verify's `uploadImage()` never set a MIME type on the multipart file part,
which a real Ghost server rejects as 415 -- invisible to its own mocked
unit test. Fixed with a filename-extension-based MIME type; re-ran the
full verify.mjs against the live service afterward -- {"ok":true}.

Manual follow-up still needed: the SNS email subscription is
PendingConfirmation until someone clicks the confirmation link AWS sent
to robots@the-well-architected-cloud.com.
