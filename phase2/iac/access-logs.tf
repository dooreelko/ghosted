# Per-page request statistics (moth klcfz): the site distribution's
# access logs, delivered via CloudFront standard logging v2 into a
# CloudWatch Logs group and read with Logs Insights.
#
# CloudWatch Logs was chosen over S3 + Athena as the first approach for
# simplicity; ingestion is billed per GB, so if that gets expensive the
# fallback is re-pointing the delivery destination at S3. v2 delivery is
# configured entirely on the CloudWatch Logs side -- the distribution's own
# (legacy) `logging_config` stays unset, so cloudfront.tf is untouched.
#
# The distribution is global but its delivery source must live in
# us-east-1, which is already this config's only region.

resource "aws_cloudwatch_log_group" "cloudfront_access" {
  # The /aws/vendedlogs/ prefix keeps the delivery service's resource
  # policy from growing per log group (AWS's recommended naming for
  # vended-log destinations).
  name              = "/aws/vendedlogs/cloudfront/ghost-site-access"
  retention_in_days = 90
}

# Lets the log delivery service write into the group. CreateDelivery would
# otherwise create an equivalent policy itself, outside of state.
resource "aws_cloudwatch_log_resource_policy" "cloudfront_access" {
  policy_name = "ghost-site-cloudfront-access-delivery"
  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AWSLogDeliveryWrite"
      Effect    = "Allow"
      Principal = { Service = "delivery.logs.amazonaws.com" }
      Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource  = "${aws_cloudwatch_log_group.cloudfront_access.arn}:log-stream:*"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
        ArnLike      = { "aws:SourceArn" = aws_cloudwatch_log_delivery_source.cloudfront_access.arn }
      }
    }]
  })
}

resource "aws_cloudwatch_log_delivery_source" "cloudfront_access" {
  name         = "ghost-site-cloudfront-access"
  log_type     = "ACCESS_LOGS"
  resource_arn = aws_cloudfront_distribution.site.arn
}

resource "aws_cloudwatch_log_delivery_destination" "cloudfront_access" {
  name          = "ghost-site-cloudfront-access"
  output_format = "json"

  delivery_destination_configuration {
    destination_resource_arn = aws_cloudwatch_log_group.cloudfront_access.arn
  }
}

resource "aws_cloudwatch_log_delivery" "cloudfront_access" {
  delivery_source_name     = aws_cloudwatch_log_delivery_source.cloudfront_access.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.cloudfront_access.arn

  # A deliberate subset of the ~33 default fields: enough for per-page,
  # cache and referrer stats while roughly halving ingestion size.
  # Deliberately excluded:
  #   c-ip, x-forwarded-for -- client IPs are personal data; unique-visitor
  #                           counts were given up to avoid storing them.
  #   cs-uri-query          -- carries Ghost member magic-link tokens
  #                           (/blog/members/?token=...), which must not sit
  #                           in logs for the retention period.
  #   cs(Cookie)            -- session cookies, same reason.
  record_fields = [
    "timestamp",
    "cs-method",
    "cs-uri-stem",
    "sc-status",
    "x-edge-result-type",
    "sc-bytes",
    "time-taken",
    "cs(Referer)",
    "cs(User-Agent)",
    "x-edge-location",
  ]

  depends_on = [aws_cloudwatch_log_resource_policy.cloudfront_access]
}

# Saved Logs Insights query: top 50 pages over whatever time range is
# picked in the console. "Pages" = successful GETs of non-asset paths,
# excluding the Ghost admin/API and self-declared crawlers -- so it
# approximates human page views, not raw request volume.
resource "aws_cloudwatch_query_definition" "top_pages" {
  name            = "ghost-site/top-pages"
  log_group_names = [aws_cloudwatch_log_group.cloudfront_access.name]

  query_string = <<-EOT
    fields `cs-uri-stem` as path
    | filter `cs-method` = "GET"
    | filter `sc-status` like /^(2|304)/
    | filter path not like /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|xml|txt|json)$/
    | filter path not like /^\/blog\/(ghost|members\/api)\//
    | filter `cs(User-Agent)` not like /(?i)(bot|crawl|spider|slurp|preview|monitor)/
    | stats count(*) as requests by path
    | sort requests desc
    | limit 50
  EOT
}
