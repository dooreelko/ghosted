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
