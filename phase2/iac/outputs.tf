output "bucket_name" {
  value = aws_s3_bucket.data.bucket
}
output "ecr_repository_url" {
  value = aws_ecr_repository.ghost.repository_url
}
output "app_runtime_role_arn" {
  value = aws_iam_role.app_runtime.arn
}
output "lightsail_service_name" {
  value = aws_lightsail_container_service.ghost.name
}
