# Phase 3 storage stage (flag: deploy_storage).

# Content bucket: generated pages, feeds, images and their size variants. Keys
# equal URL paths under /blog. Read by CloudFront through an origin access
# control (policy added with the distribution change); written only by the
# generator and the image functions.
resource "aws_s3_bucket" "content" {
  count = var.deploy_storage ? 1 : 0

  bucket = "ghost-phase3-content-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "content" {
  count = var.deploy_storage ? 1 : 0

  bucket = aws_s3_bucket.content[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Store bucket: the SQLite store (segments, manifest, leases) only. It holds
# the only copy of the blog, so nothing that writes content may reach it and
# CloudFront never reads it.
resource "aws_s3_bucket" "store" {
  count = var.deploy_storage ? 1 : 0

  bucket = "ghost-phase3-store-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "store" {
  count = var.deploy_storage ? 1 : 0

  bucket = aws_s3_bucket.store[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Where the function zip is staged for a deploy: the direct upload limit (50 MB) is
# smaller than the zip can grow. Private; old zips expire.
resource "aws_s3_bucket" "deploy" {
  count = var.deploy_functions ? 1 : 0

  bucket = "ghost-phase3-deploy-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "deploy" {
  count = var.deploy_functions ? 1 : 0

  bucket = aws_s3_bucket.deploy[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "deploy" {
  count = var.deploy_functions ? 1 : 0

  bucket = aws_s3_bucket.deploy[0].id

  rule {
    id     = "expire-old-zips"
    status = "Enabled"

    filter {}

    expiration {
      days = 14
    }
  }
}
