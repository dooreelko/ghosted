data "aws_caller_identity" "current" {}

# Content bucket: generated pages, feeds, images and their size variants. Keys
# equal URL paths under /blog. Read by CloudFront through an origin access
# control (policy added with the distribution); written only by the generator
# and the image functions.
resource "aws_s3_bucket" "content" {
  bucket = "ghost-phase3-content-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "content" {
  bucket = aws_s3_bucket.content.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Store bucket: the SQLite store (segments, manifest, leases) only. It holds
# the only copy of the blog, so nothing that writes content may reach it and
# CloudFront never reads it.
resource "aws_s3_bucket" "store" {
  bucket = "ghost-phase3-store-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "store" {
  bucket = aws_s3_bucket.store.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
