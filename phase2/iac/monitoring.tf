# Custom metrics published from the container's own runtime identity (see
# ghost-sqlite-s3-launcher/src/metrics.mjs), rather than relying on
# Lightsail's limited built-in logs/metrics -- moth ticket rk2qo, follow-up
# to zwx7x's checkpoint-race fix. See
# docs/superpowers/specs/2026-09-10-checkpoint-monitoring-design.md.

variable "alarm_email" {
  description = "Email address subscribed to the checkpoint/restore leak alarms."
  type        = string
  default     = "robots@the-well-architected-cloud.com"
}

resource "aws_sns_topic" "checkpoint_alarms" {
  name = "ghost-phase2-checkpoint-alarms"
}

resource "aws_sns_topic_subscription" "checkpoint_alarms_email" {
  topic_arn = aws_sns_topic.checkpoint_alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  # Metrics are published once per boot (see the launcher's preload.mjs),
  # not continuously -- boots are irregular (deploys, restarts), so a wide
  # evaluation window and notBreaching-on-missing-data are required: absent
  # data means "no boot happened," not "the check failed."
  alarm_period_seconds = 7 * 24 * 60 * 60 # 1 week, matching tcho2's planned auto-update cadence
}

# Direct signal that the original bug's failure mode (unbounded segment
# leakage) has recurred: any orphaned segment found by the launcher's
# boot-time dry-run sweep is unexpected under normal operation.
resource "aws_cloudwatch_metric_alarm" "orphaned_segments" {
  alarm_name          = "ghost-phase2-orphaned-segments"
  alarm_description   = "A boot-time dry-run sweep found orphaned sqlite-s3 segments -- the checkpoint/reclamation fix (zwx7x) may have regressed."
  namespace           = "GhostPhase2/SqliteS3"
  metric_name         = "OrphanedSegmentCount"
  statistic           = "Maximum"
  period              = local.alarm_period_seconds
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.checkpoint_alarms.arn]
  ok_actions          = [aws_sns_topic.checkpoint_alarms.arn]
}

# Signals that the TOCTOU race between a caller's manifest read and
# restoreLocalDb's own lease acquisition (parked, then closed with a
# bounded retry -- see zwx7x) actually fired in production. A nonzero
# count is not itself a failure (the retry succeeded), but it is exactly
# the metric that would show whether that race is rare or common.
resource "aws_cloudwatch_metric_alarm" "restore_retries" {
  alarm_name          = "ghost-phase2-restore-retries"
  alarm_description   = "restoreLocalDb had to re-read the manifest and retry at least once during a boot -- the TOCTOU race zwx7x parked/closed with a retry is firing in production."
  namespace           = "GhostPhase2/SqliteS3"
  metric_name         = "RestoreRetryCount"
  statistic           = "Maximum"
  period              = local.alarm_period_seconds
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.checkpoint_alarms.arn]
  ok_actions          = [aws_sns_topic.checkpoint_alarms.arn]
}

# Early warning for the other parked risk: lease.refresh() is implemented
# but never called, so restoreLocalDb relies on a fixed 5-minute lease TTL
# (leaseTtlMs in restore.js). Alarm at half that TTL so a restore trending
# toward it is caught before it actually outruns its lease.
resource "aws_cloudwatch_metric_alarm" "restore_duration" {
  alarm_name          = "ghost-phase2-restore-duration-high"
  alarm_description   = "A boot-time restore took over half the lease TTL (2.5 of 5 minutes) -- restoreLocalDb's lease.refresh() is unused, so a slower restore risks outrunning its lease protection."
  namespace           = "GhostPhase2/SqliteS3"
  metric_name         = "RestoreDurationMs"
  statistic           = "Maximum"
  period              = local.alarm_period_seconds
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 150000 # 2.5 minutes, half the 5-minute default lease TTL
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.checkpoint_alarms.arn]
  ok_actions          = [aws_sns_topic.checkpoint_alarms.arn]
}
