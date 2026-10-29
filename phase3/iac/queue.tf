# Generate queue (flag: deploy_functions). Every change event (admin write,
# scheduled publish) enqueues a request and the generator is triggered from
# the queue; failed or timed-out runs reappear after the visibility timeout,
# up to a bounded retry count, then land in the dead-letter queue, which has an
# alarm. The generator drops queued duplicates after a successful run.

resource "aws_sqs_queue" "generate_dlq" {
  count = var.deploy_functions ? 1 : 0

  name                      = "ghost-phase3-generate-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "generate" {
  count = var.deploy_functions ? 1 : 0

  name = "ghost-phase3-generate"
  # Must exceed the generator's timeout (checked below); AWS recommends six
  # times the function timeout for queue-triggered functions.
  visibility_timeout_seconds = local.functions["generator"].timeout * 6

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.generate_dlq[0].arn
    maxReceiveCount     = 3
  })
}
