resource "aws_lightsail_container_service_deployment_version" "ghost" {
  service_name = aws_lightsail_container_service.ghost.name

  container {
    container_name = "ghost"
    image          = "${aws_ecr_repository.ghost.repository_url}:${var.image_tag}"

    environment = {
      SQLITE_S3_BUCKET    = aws_s3_bucket.data.bucket
      SQLITE_S3_REGION    = "us-east-1"
      AWS_ROLE_ARN        = aws_iam_role.app_runtime.arn
      GHOST_URL           = "https://the-well-architected-cloud.com/blog"
      MAIL_SSM_PARAM_NAME = "ghost_imap_token"
      # Ghost core's boot.js is already instrumented with the `debug` npm
      # package (namespace "ghost:*", since ghost/core's package.json has no
      # `alias` field) -- it writes to stderr by default, the same channel
      # our own preload.mjs checkpoints (rounds 10-11) already confirmed
      # comes through Lightsail's log capture cleanly. Surfacing Ghost's own
      # existing internal boot-timing instrumentation for free, no code
      # change needed.
      DEBUG = "ghost:*"
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
      path                = "/"
      success_codes       = "200-399"
    }
  }
}

variable "image_tag" {
  type        = string
  description = "Git short-SHA tag of the image to deploy (set via -var on each deploy)"
}
