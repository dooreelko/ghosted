# Verify at apply time (Task 10) whether the AWS provider's
# aws_lightsail_container_service resource exposes the principal ARN as a
# computed attribute directly (check `tofu providers schema -json | jq
# '.provider_schemas."registry.opentofu.org/hashicorp/aws".resource_schemas."aws_lightsail_container_service"'`
# for a `principal_arn` or similarly-named field). If it's exposed, reference
# it directly below. If not, fall back to a `data "aws_lightsail_container_service"`
# data source (often exposes attributes a resource block doesn't) or, as a last
# resort, an `aws lightsail get-container-services` CLI call captured via an
# `external` data source. Placeholder reference below assumes the resource
# attribute exists — Task 10 corrects this if it doesn't.
data "aws_iam_policy_document" "app_runtime_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [aws_lightsail_container_service.ghost.private_registry_access[0].ecr_image_puller_role[0].principal_arn == null ? "" : aws_lightsail_container_service.ghost.arn]
    }
  }
}

resource "aws_iam_role" "app_runtime" {
  name               = "ghost-phase2-app-runtime"
  assume_role_policy = data.aws_iam_policy_document.app_runtime_trust.json
}

data "aws_iam_policy_document" "app_runtime_permissions" {
  statement {
    sid    = "S3DataBucketCrud"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.data.arn,
      "${aws_s3_bucket.data.arn}/*",
    ]
  }

  statement {
    sid       = "MailCredentialRead"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:us-east-1:${data.aws_caller_identity.current.account_id}:parameter/ghost_imap_token"]
  }

  statement {
    sid       = "MailCredentialDecrypt"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["*"] # narrow to the specific KMS key ARN at apply time once known (Task 10) — SSM SecureString params typically use the account's default aws/ssm key
  }
}

resource "aws_iam_role_policy" "app_runtime_permissions" {
  name   = "ghost-phase2-app-runtime-permissions"
  role   = aws_iam_role.app_runtime.id
  policy = data.aws_iam_policy_document.app_runtime_permissions.json
}
