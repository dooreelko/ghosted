# Checkpoint monitoring: CloudWatch metrics & leak alarms — design

Moth: rk2qo (follow-up to zwx7x)

## Problem

`zwx7x` fixed the checkpoint race that let segments leak unboundedly, but
left two residual risks explicitly parked rather than fully closed:

1. A narrow TOCTOU between the caller's manifest read (`knex-client.js`)
   and `restoreLocalDb`'s own lease acquisition — closed with a bounded
   retry, but the retry existing at all means the race can still occur.
2. `lease.refresh()` is implemented and tested but never called —
   `restoreLocalDb` relies on a fixed 5-minute TTL, which is fine at the
   current database size but would silently stop protecting a restore that
   outruns it if the backlog grows large again.

Neither risk is hypothetical: the original bug (572MB of garbage in 16
hours) was only found because someone happened to inspect the store after
an unusually long idle period. Lightsail's own logs/metrics are not enough
to catch a slow-accumulating regression like that on their own.

## Design

### Metrics — published once per boot, from `ghost-sqlite-s3-launcher/src/preload.mjs`

The launcher already assumes the container's own IAM role and already
constructs `objectStore`/`manifestStore`/`segmentStore`/`leaseStore` — it
publishes metrics directly via `@aws-sdk/client-cloudwatch`, fire-and-forget
and non-fatal (a CloudWatch failure must never block Ghost's boot).

- **`OrphanedSegmentCount`** — a dry-run `reclaimOrphanedSegments()` call
  right after `s3Config` is built. Direct signal for the original bug's
  failure mode recurring.
- **`RestoreRetryCount`** — how many times the boot-time `restoreLocalDb`
  call had to re-read the manifest and retry. `restoreLocalDb` returns
  `{ attempts, durationMs }` (previously returned nothing); `knex-client.js`
  forwards this to a new, purely-observational `s3.onRestoreComplete(stats)`
  hook, the one dependency in this feature allowed a no-op default, since
  it cannot affect correctness — only visibility. The launcher supplies it.
- **`RestoreDurationMs`** — wall-clock time for the same restore, from the
  same hook. Early warning for the lease-TTL risk above.

### Alarms (`phase2/iac/`)

- New `aws_sns_topic` + `aws_sns_topic_subscription` (email:
  `robots@the-well-architected-cloud.com`).
- Three `aws_cloudwatch_metric_alarm` resources, all
  `treat_missing_data = "notBreaching"` (boots are irregular, so absent
  data must never itself alarm):
  - `OrphanedSegmentCount > 0`
  - `RestoreRetryCount > 0`
  - `RestoreDurationMs > 150000` (half the 5-minute lease TTL)
- IAM: add a `cloudwatch:PutMetricData` statement to the existing
  `app_runtime_permissions` policy on `aws_iam_role.app_runtime`. This
  action does not support resource-level scoping in IAM, so the statement
  is `Resource = "*"` (a documented AWS limitation, not a scoping choice).

### Accepted gap

Per-boot cadence cannot catch a leak during a long uptime with zero
restarts — the exact scenario that hid the original bug for 16 hours.
Mitigated by `tcho2` (weekly auto-update, causing a restart at least once a
week) — that ticket exists but is not yet implemented. This is a known,
documented limitation of this design, not a silent one; if `tcho2` slips,
this gap persists.

## Out of scope

- `CheckpointOutcome` metrics (success/abandon counts per checkpoint
  attempt) — deferred; not part of this ticket.
- Any automated deploy pipeline integration — deploy for this change is a
  manual `tofu apply` plus a manual container rebuild/redeploy. The
  automated pipeline (`phase2/scripts/deploy.sh`) exists only on the
  unmerged `i8hlt-deploy-observability` branch.
- Any change to alarm thresholds beyond the three above, or additional
  notification channels (Slack, PagerDuty, etc.) — email only, for now.
