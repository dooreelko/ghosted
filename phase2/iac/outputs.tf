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
