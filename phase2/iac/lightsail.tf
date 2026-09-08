resource "aws_lightsail_container_service" "ghost" {
  name        = "ghost-phase2"
  power       = "micro"
  scale       = 1
  is_disabled = false

  private_registry_access {
    ecr_image_puller_role {
      is_active = true
    }
  }
}

resource "aws_ecr_repository_policy" "lightsail_pull" {
  repository = aws_ecr_repository.ghost.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AllowLightsailPull"
      Effect = "Allow"
      Principal = {
        AWS = aws_lightsail_container_service.ghost.private_registry_access[0].ecr_image_puller_role[0].principal_arn
      }
      Action = [
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
      ]
    }]
  })
}
