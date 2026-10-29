output "content_bucket" {
  description = "Name of the content bucket (pages, feeds, images)."
  value       = aws_s3_bucket.content.bucket
}

output "store_bucket" {
  description = "Name of the SQLite store bucket."
  value       = aws_s3_bucket.store.bucket
}
