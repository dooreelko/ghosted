resource "aws_lightsail_container_service" "ghost" {
  count = var.deploy_lightsail ? 1 : 0

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

# The ECR *repository* is a prereq (the image is pushed before Lightsail
# exists), but this policy names Lightsail's own puller principal, so it can
# only exist once the service does.
resource "aws_ecr_repository_policy" "lightsail_pull" {
  count = var.deploy_lightsail ? 1 : 0

  repository = aws_ecr_repository.ghost.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AllowLightsailPull"
      Effect = "Allow"
      Principal = {
        AWS = aws_lightsail_container_service.ghost[0].private_registry_access[0].ecr_image_puller_role[0].principal_arn
      }
      Action = [
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
      ]
    }]
  })
}
