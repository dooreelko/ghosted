resource "aws_lightsail_container_service_deployment_version" "ghost" {
  count = var.deploy_lightsail ? 1 : 0

  service_name = aws_lightsail_container_service.ghost[0].name

  container {
    container_name = "ghost"
    image          = "${aws_ecr_repository.ghost.repository_url}:${var.image_tag}"

    environment = {
      SQLITE_S3_BUCKET    = aws_s3_bucket.data.bucket
      SQLITE_S3_REGION    = "us-east-1"
      AWS_ROLE_ARN        = aws_iam_role.app_runtime[0].arn
      GHOST_URL           = "https://the-well-architected-cloud.com/blog"
      MAIL_SSM_PARAM_NAME = "ghost_imap_token"
    }

    ports = {
      "2368" = "HTTP"
    }
  }

  public_endpoint {
    container_name = "ghost"
    container_port = 2368

    health_check {
      healthy_threshold   = 2
      unhealthy_threshold = 5
      timeout_seconds     = 10
      interval_seconds    = 30
      # GHOST_URL is a "/blog" subpath (see environment above) -- Ghost's
      # frontend 404s on bare "/" when configured this way (confirmed via
      # local repro), so the health check must probe the same subpath Ghost
      # actually serves, not the container root.
      path          = "/blog/"
      success_codes = "200-399"
    }
  }
}
