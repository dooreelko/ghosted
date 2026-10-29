# Phase 3 functions (flag: deploy_functions). One Lambda per group from the
# endpoint inventory in phase3/readme.md, each with its own role scoped to
# what it needs and its own sizing. Sizes are starting hypotheses, tuned after
# the first deploy from measured cold starts.
#
# The infrastructure code owns configuration; the deploy script owns code, so
# the package is a placeholder here and ignored afterwards.

locals {
  # store: "rw" full access to the SQLite store, "ro" reads the store and
  # keeps only its reader leases, "none" no access.
  # content: "rw" read+write, "ro" read, "none".
  functions = {
    # Reader-facing
    image-resize    = { memory = 1024, timeout = 30, concurrency = 2, store = "none", content = "rw", queue = false, smtp = false, description = "Size-variant fallback on a missing image" }
    link-redirect   = { memory = 256, timeout = 10, concurrency = 2, store = "rw", content = "none", queue = false, smtp = false, description = "Newsletter click-tracking redirect" }
    members-session = { memory = 1024, timeout = 15, concurrency = 5, store = "rw", content = "none", queue = false, smtp = false, description = "Members app: session, member, magic links" }
    comments        = { memory = 512, timeout = 15, concurrency = 3, store = "rw", content = "none", queue = false, smtp = false, description = "Comments router" }
    webmentions     = { memory = 256, timeout = 10, concurrency = 1, store = "rw", content = "none", queue = false, smtp = false, description = "Webmention receiver" }
    content-api     = { memory = 512, timeout = 15, concurrency = 2, store = "ro", content = "none", queue = false, smtp = false, description = "Content API (read-only)" }
    # Render
    generator = { memory = 2048, timeout = 600, concurrency = 2, store = "ro", content = "rw", content_delete = true, queue = false, smtp = false, description = "Renders pages from a store snapshot, runs the image preflight" }
    preview   = { memory = 1024, timeout = 15, concurrency = 2, store = "ro", content = "ro", queue = false, smtp = false, description = "Draft preview, email web view, unsubscribe, gift preview" }
    # Admin
    admin-content  = { memory = 1024, timeout = 30, concurrency = 3, store = "rw", content = "none", queue = true, smtp = false, description = "Admin API: posts, pages, tags, schedules" }
    admin-audience = { memory = 1024, timeout = 30, concurrency = 2, store = "rw", content = "none", queue = true, smtp = false, description = "Admin API: members, newsletters, comments moderation" }
    admin-site     = { memory = 512, timeout = 30, concurrency = 2, store = "rw", content = "none", queue = true, smtp = false, description = "Admin API: auth, users, settings, themes" }
    admin-heavy    = { memory = 2048, timeout = 300, concurrency = 1, store = "rw", content = "rw", queue = true, smtp = false, description = "Admin API: uploads, imports, exports" }
    # Background
    scheduled-publish = { memory = 1024, timeout = 60, concurrency = 1, store = "rw", content = "none", queue = true, smtp = false, description = "Publishes a scheduled post when its one-shot schedule fires" }
    email-send        = { memory = 1024, timeout = 300, concurrency = 2, store = "rw", content = "ro", queue = false, smtp = true, description = "Newsletter send, with the image preflight" }
    maintenance       = { memory = 512, timeout = 120, concurrency = 1, store = "rw", content = "none", queue = false, smtp = false, description = "Recurring cleanup jobs" }
    sqlite-checkpoint = { memory = 1024, timeout = 120, concurrency = 1, store = "rw", content = "none", queue = false, smtp = false, description = "Checkpoint, compaction and orphan sweep" }
  }

  active_functions = var.deploy_functions ? local.functions : {}
}

data "archive_file" "placeholder" {
  type        = "zip"
  source_file = "${path.module}/../packages/placeholder/index.mjs"
  output_path = "${path.module}/.build/placeholder.zip"
}

resource "aws_cloudwatch_log_group" "function" {
  for_each = local.active_functions

  name              = "/aws/lambda/ghost-phase3-${each.key}"
  retention_in_days = 30
}

data "aws_iam_policy_document" "function_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "function" {
  for_each = local.active_functions

  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.function[each.key].arn}:*"]
  }

  dynamic "statement" {
    for_each = each.value.store == "rw" ? [1] : []
    content {
      sid    = "StoreReadWrite"
      effect = "Allow"
      actions = [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:AbortMultipartUpload",
      ]
      resources = [aws_s3_bucket.store[0].arn, "${aws_s3_bucket.store[0].arn}/*"]
    }
  }

  # Read-only store access still writes its own TTL'd reader leases, so a
  # concurrent checkpoint cannot reclaim segments out from under a restore.
  dynamic "statement" {
    for_each = each.value.store == "ro" ? [1] : []
    content {
      sid       = "StoreRead"
      effect    = "Allow"
      actions   = ["s3:GetObject", "s3:ListBucket"]
      resources = [aws_s3_bucket.store[0].arn, "${aws_s3_bucket.store[0].arn}/*"]
    }
  }

  dynamic "statement" {
    for_each = each.value.store == "ro" ? [1] : []
    content {
      sid       = "StoreReaderLeases"
      effect    = "Allow"
      actions   = ["s3:PutObject", "s3:DeleteObject"]
      resources = ["${aws_s3_bucket.store[0].arn}/leases/*"]
    }
  }

  dynamic "statement" {
    for_each = each.value.content == "rw" ? [1] : []
    content {
      sid       = "ContentReadWrite"
      effect    = "Allow"
      actions   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
      resources = [aws_s3_bucket.content[0].arn, "${aws_s3_bucket.content[0].arn}/*"]
    }
  }

  dynamic "statement" {
    for_each = each.value.content == "ro" ? [1] : []
    content {
      sid       = "ContentRead"
      effect    = "Allow"
      actions   = ["s3:GetObject", "s3:ListBucket"]
      resources = [aws_s3_bucket.content[0].arn, "${aws_s3_bucket.content[0].arn}/*"]
    }
  }

  # Only the generator deletes, and only keys it created and tracks.
  dynamic "statement" {
    for_each = try(each.value.content_delete, false) ? [1] : []
    content {
      sid       = "ContentDeleteOwned"
      effect    = "Allow"
      actions   = ["s3:DeleteObject"]
      resources = ["${aws_s3_bucket.content[0].arn}/*"]
    }
  }

  dynamic "statement" {
    for_each = each.value.queue ? [1] : []
    content {
      sid       = "EnqueueGenerate"
      effect    = "Allow"
      actions   = ["sqs:SendMessage"]
      resources = [aws_sqs_queue.generate[0].arn]
    }
  }

  dynamic "statement" {
    for_each = each.value.smtp ? [1] : []
    content {
      sid       = "SmtpCredentialRead"
      effect    = "Allow"
      actions   = ["ssm:GetParameter"]
      resources = ["arn:aws:ssm:us-east-1:${data.aws_caller_identity.current.account_id}:parameter/${var.smtp_parameter_name}"]
    }
  }

  dynamic "statement" {
    for_each = each.value.smtp ? [1] : []
    content {
      sid       = "SmtpCredentialDecrypt"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = [data.aws_kms_alias.ssm_default.target_key_arn]
    }
  }
}

resource "aws_iam_role" "function" {
  for_each = local.active_functions

  name               = "ghost-phase3-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.function_trust.json
}

resource "aws_iam_role_policy" "function" {
  for_each = local.active_functions

  name   = "ghost-phase3-${each.key}"
  role   = aws_iam_role.function[each.key].id
  policy = data.aws_iam_policy_document.function[each.key].json
}

resource "aws_lambda_function" "function" {
  for_each = local.active_functions

  function_name = "ghost-phase3-${each.key}"
  description   = each.value.description
  role          = aws_iam_role.function[each.key].arn
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = each.value.memory
  timeout       = each.value.timeout

  reserved_concurrent_executions = each.value.concurrency

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256

  environment {
    variables = {
      GHOST_URL          = var.site_url
      STORE_BUCKET       = aws_s3_bucket.store[0].bucket
      CONTENT_BUCKET     = aws_s3_bucket.content[0].bucket
      GENERATE_QUEUE_URL = aws_sqs_queue.generate[0].url
    }
  }

  depends_on = [aws_iam_role_policy.function, aws_cloudwatch_log_group.function]

  lifecycle {
    # The deploy script updates the code.
    ignore_changes = [filename, source_code_hash]
  }
}
