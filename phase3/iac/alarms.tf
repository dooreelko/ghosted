# Alarms for the Phase 3 stage (flag: deploy_functions), sent to the existing
# alarm topic: anything in the generate dead-letter queue, generator errors,
# and server errors from the API.

resource "aws_cloudwatch_metric_alarm" "generate_dlq" {
  count = var.deploy_functions ? 1 : 0

  alarm_name          = "ghost-phase3-generate-dlq-not-empty"
  alarm_description   = "A generate request exhausted its retries; pages may be stale. Inspect the dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.generate_dlq[0].name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.checkpoint_alarms.arn]
  ok_actions          = [aws_sns_topic.checkpoint_alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "generator_errors" {
  count = var.deploy_functions ? 1 : 0

  alarm_name          = "ghost-phase3-generator-errors"
  alarm_description   = "The generator function reported errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.function["generator"].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.checkpoint_alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  count = var.deploy_functions ? 1 : 0

  alarm_name          = "ghost-phase3-api-5xx"
  alarm_description   = "The API returned server errors."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.site[0].id }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.checkpoint_alarms.arn]
}
