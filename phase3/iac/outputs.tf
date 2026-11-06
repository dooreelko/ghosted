# Phase 2's data bucket (Phase 3 no longer manages it); the seed script reads the
# store segments and images from it by this name.
output "bucket_name" {
  value = "ghost-phase2-data-${data.aws_caller_identity.current.account_id}"
}

output "content_bucket" {
  description = "Name of the content bucket (pages, feeds, images); null until deploy_storage."
  value       = one(aws_s3_bucket.content[*].bucket)
}

output "store_bucket" {
  description = "Name of the SQLite store bucket; null until deploy_storage."
  value       = one(aws_s3_bucket.store[*].bucket)
}

output "api_endpoint" {
  description = "Invoke URL of the Phase 3 API (null until deploy_functions). Reached through CloudFront, not directly."
  value       = one(aws_apigatewayv2_api.site[*].api_endpoint)
}
