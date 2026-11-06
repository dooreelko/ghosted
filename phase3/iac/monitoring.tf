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

