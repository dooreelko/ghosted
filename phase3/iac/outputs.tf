output "bucket_name" {
  value = aws_s3_bucket.data.bucket
}

output "ecr_repository_url" {
  value = aws_ecr_repository.ghost.repository_url
}

# The three Lightsail-dependent outputs are null when deploy_lightsail is
# false. `one()` turns a count-gated resource's 0-or-1 element list into
# null-or-the-value, which is exactly the shape callers want; deploy.sh reads
# these with `tofu output -raw` and will print an empty string.
output "app_runtime_role_arn" {
  value = one(aws_iam_role.app_runtime[*].arn)
}

output "lightsail_service_name" {
  value = one(aws_lightsail_container_service.ghost[*].name)
}

output "public_url" {
  value = one(aws_lightsail_container_service.ghost[*].url)
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
