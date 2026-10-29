# Triggers (flag: deploy_functions): the generate queue feeds the generator,
# EventBridge Scheduler runs the recurring jobs and the one-shot publish
# schedules the admin function creates at runtime. Recurring schedules stay
# disabled until cutover (enable_schedules) so Phase 3's background jobs never
# run next to Phase 2's in-process ones.

resource "aws_lambda_event_source_mapping" "generate" {
  count = var.deploy_functions ? 1 : 0

  event_source_arn = aws_sqs_queue.generate[0].arn
  function_name    = aws_lambda_function.function["generator"].arn
  batch_size       = 1

  scaling_config {
    maximum_concurrency = 2
  }
}

resource "aws_scheduler_schedule_group" "ghost" {
  count = var.deploy_functions ? 1 : 0

  name = "ghost-phase3"
}

data "aws_iam_policy_document" "scheduler_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  count = var.deploy_functions ? 1 : 0

  name               = "ghost-phase3-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_trust.json
}

resource "aws_iam_role_policy" "scheduler" {
  count = var.deploy_functions ? 1 : 0

  name = "ghost-phase3-scheduler"
  role = aws_iam_role.scheduler[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "lambda:InvokeFunction"
      Resource = [
        for f in ["scheduled-publish", "maintenance", "sqlite-checkpoint"] :
        "arn:aws:lambda:us-east-1:${data.aws_caller_identity.current.account_id}:function:ghost-phase3-${f}"
      ]
    }]
  })
}

locals {
  recurring = {
    for name, expression in {
      maintenance       = "rate(1 day)"
      sqlite-checkpoint = "rate(6 hours)"
    } : name => expression if var.deploy_functions
  }
}

resource "aws_scheduler_schedule" "recurring" {
  for_each = local.recurring

  name       = "ghost-phase3-${each.key}"
  group_name = aws_scheduler_schedule_group.ghost[0].name
  state      = var.enable_schedules ? "ENABLED" : "DISABLED"

  schedule_expression = each.value

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.function[each.key].arn
    role_arn = aws_iam_role.scheduler[0].arn
    input    = jsonencode({ source = "schedule" })
  }
}
