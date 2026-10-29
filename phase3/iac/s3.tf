resource "aws_s3_bucket" "data" {
  bucket = "ghost-phase2-data-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket = aws_s3_bucket.data.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_caller_identity" "current" {}

# Read access for the site distribution, scoped to the image prefix only — the
# same bucket also holds the SQLite store's segments and manifest, which must
# never be publicly reachable. The public access block above stays fully on;
# an OAC bucket policy is not "public" access.
data "aws_iam_policy_document" "data_cloudfront_read" {
  count = var.deploy_cloudfront ? 1 : 0

  statement {
    sid       = "AllowCloudFrontOACReadImages"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.data.arn}/blog/content/images/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "data_cloudfront_read" {
  count = var.deploy_cloudfront ? 1 : 0

  bucket = aws_s3_bucket.data.id
  policy = data.aws_iam_policy_document.data_cloudfront_read[0].json
}
