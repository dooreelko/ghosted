# Phase 1's hand-created distribution, brought under state via `import`
# (Task 9's runbook runs the actual `tofu import`). It serves the whole
# site: the marketing root from S3, and `/blog*` from the EC2 VPC origin.
# It is not gated by any deploy_* flag -- it always exists once imported.
# `deploy_cloudfront` only switches which origin the /blog* behaviours
# point at, and adds the image behaviour.
#
# The managed cache/origin-request policies below are looked up by name
# rather than hardcoded by ID so no CloudFront resource ID needs to live
# in this tracked file. See .local-secrets.md (Phase 1 heading) for the
# distribution ID, the VPC origin ID, and the custom cache policy's ID --
# none of them belong here.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "blog_short_ttl" {
  name = "ghost-classic-blog-short-ttl"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

# Looked up by domain rather than hardcoding the ARN, which embeds the
# account ID.
data "aws_acm_certificate" "site" {
  domain      = "the-well-architected-cloud.com"
  types       = ["AMAZON_ISSUED"]
  most_recent = true
}

resource "aws_cloudfront_distribution" "site" {
  aliases                         = ["the-well-architected-cloud.com"]
  comment                         = null
  continuous_deployment_policy_id = ""
  default_root_object             = "index.html"
  enabled                         = true
  http_version                    = "http2"
  is_ipv6_enabled                 = true
  price_class                     = "PriceClass_100"
  retain_on_delete                = false
  staging                         = false
  tags = {
    Name = "the-well-architected-cloud.com"
  }
  tags_all = {
    Name = "the-well-architected-cloud.com"
  }
  wait_for_deployment = true
  web_acl_id          = ""

  # This distribution serves the entire live site; `tofu destroy` on this
  # directory was routine at the end of hnj9a and must never take this out.
  lifecycle {
    prevent_destroy = true

    # The provider's default_tags would otherwise add app=ghost-phase2 to
    # this Phase 1 resource's tags_all, which is an unapproved mutation on
    # production outside the flag-gated flow this task is scoped to -- and
    # it would mask real drift behind the gate's "0 to change" plan.
    ignore_changes = [tags_all]
  }

  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    default_ttl                = 0
    field_level_encryption_id  = ""
    max_ttl                    = 0
    min_ttl                    = 0
    origin_request_policy_id   = ""
    realtime_log_config_arn    = ""
    response_headers_policy_id = ""
    smooth_streaming           = false
    target_origin_id           = "the-well-architected-cloud.com.s3.eu-central-1.amazonaws.com-mf4f3dx09q5"
    trusted_key_groups         = []
    trusted_signers            = []
    viewer_protocol_policy     = "redirect-to-https"
    grpc_config {
      enabled = false
    }
  }

  ordered_cache_behavior {
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    default_ttl                = 0
    field_level_encryption_id  = ""
    max_ttl                    = 0
    min_ttl                    = 0
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer.id
    path_pattern               = "blog/ghost/*"
    realtime_log_config_arn    = ""
    response_headers_policy_id = ""
    smooth_streaming           = false
    target_origin_id           = "ghost-classic-appserver-vpc-origin"
    trusted_key_groups         = []
    trusted_signers            = []
    viewer_protocol_policy     = "redirect-to-https"
    grpc_config {
      enabled = false
    }
  }

  ordered_cache_behavior {
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    default_ttl                = 0
    field_level_encryption_id  = ""
    max_ttl                    = 0
    min_ttl                    = 0
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer.id
    path_pattern               = "blog/members/*"
    realtime_log_config_arn    = ""
    response_headers_policy_id = ""
    smooth_streaming           = false
    target_origin_id           = "ghost-classic-appserver-vpc-origin"
    trusted_key_groups         = []
    trusted_signers            = []
    viewer_protocol_policy     = "redirect-to-https"
    grpc_config {
      enabled = false
    }
  }

  # The image behaviour must come before /blog* -- ordered_cache_behavior
  # blocks are matched in file order, and /blog* would otherwise shadow it.
  # Empty (and thus no-op) unless deploy_cloudfront = true.
  dynamic "ordered_cache_behavior" {
    for_each = var.deploy_cloudfront ? [1] : []
    content {
      path_pattern           = "/blog/content/images/*"
      target_origin_id       = "s3-ghost-phase2-data"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true

      forwarded_values {
        query_string = false
        cookies {
          forward = "none"
        }
      }
    }
  }

  ordered_cache_behavior {
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.blog_short_ttl.id
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    default_ttl                = 0
    field_level_encryption_id  = ""
    max_ttl                    = 0
    min_ttl                    = 0
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer.id
    path_pattern               = "blog/*"
    realtime_log_config_arn    = ""
    response_headers_policy_id = ""
    smooth_streaming           = false
    # With deploy_cloudfront = false this keeps pointing at the Phase 1 EC2
    # origin below; flipping the flag (Task 9's cutover runbook) switches it
    # to the Lightsail origin instead.
    target_origin_id       = var.deploy_cloudfront ? "lightsail-ghost-phase2" : "ghost-classic-appserver-vpc-origin"
    trusted_key_groups     = []
    trusted_signers        = []
    viewer_protocol_policy = "redirect-to-https"
    grpc_config {
      enabled = false
    }
  }

  ordered_cache_behavior {
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.blog_short_ttl.id
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    default_ttl                = 0
    field_level_encryption_id  = ""
    max_ttl                    = 0
    min_ttl                    = 0
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer.id
    path_pattern               = "blog"
    realtime_log_config_arn    = ""
    response_headers_policy_id = ""
    smooth_streaming           = false
    target_origin_id           = "ghost-classic-appserver-vpc-origin"
    trusted_key_groups         = []
    trusted_signers            = []
    viewer_protocol_policy     = "redirect-to-https"
    grpc_config {
      enabled = false
    }
  }

  # Phase 1 EC2 origin, via CloudFront's VPC-origin feature. Left as
  # generated: there is no name-based data source for a VPC origin, so its
  # ID is an unavoidable literal here -- see .local-secrets.md (Phase 1
  # heading, "CloudFront VPC origin") for what it points at.
  origin {
    connection_attempts = 3
    connection_timeout  = 10
    domain_name         = "ip-172-30-0-204.ec2.internal"
    origin_id           = "ghost-classic-appserver-vpc-origin"
    origin_path         = ""
    vpc_origin_config {
      origin_keepalive_timeout = 5
      origin_read_timeout      = 30
      vpc_origin_id            = "vo_9dZLR0ZDlJGBe3m7LL7vht"
    }
  }

  # Phase 1 marketing-root S3 origin (not part of phase2 state). Its OAC ID
  # has no name-based data source either, so it too stays a literal --
  # unrelated to the phase2 data-bucket OAC created below.
  origin {
    connection_attempts      = 3
    connection_timeout       = 10
    domain_name              = "the-well-architected-cloud.com.s3.eu-central-1.amazonaws.com"
    origin_access_control_id = "E720X64XOT8CG"
    origin_id                = "the-well-architected-cloud.com.s3.eu-central-1.amazonaws.com-mf4f3dx09q5"
    origin_path              = ""
  }

  # The Lightsail origin exists only while the container service does. With
  # deploy_lightsail = false this list is empty and the /blog* behaviours
  # keep pointing at the Phase 1 EC2 origin.
  dynamic "origin" {
    for_each = var.deploy_lightsail ? [1] : []
    content {
      origin_id   = "lightsail-ghost-phase2"
      domain_name = replace(replace(aws_lightsail_container_service.ghost[0].url, "https://", ""), "/", "")

      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  # The data bucket, so /blog/content/images/* is served straight from S3
  # rather than through the container. The OAC below is what makes this
  # readable while the bucket itself stays private.
  dynamic "origin" {
    for_each = var.deploy_cloudfront ? [1] : []
    content {
      origin_id                = "s3-ghost-phase2-data"
      domain_name              = aws_s3_bucket.data.bucket_regional_domain_name
      origin_access_control_id = aws_cloudfront_origin_access_control.data[0].id
    }
  }

  restrictions {
    geo_restriction {
      locations        = []
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn            = data.aws_acm_certificate.site.arn
    cloudfront_default_certificate = false
    iam_certificate_id             = ""
    minimum_protocol_version       = "TLSv1.2_2021"
    ssl_support_method             = "sni-only"
  }
}

resource "aws_cloudfront_origin_access_control" "data" {
  count = var.deploy_cloudfront ? 1 : 0

  name                              = "ghost-phase2-data"
  description                       = "Lets the site distribution read images out of the private phase2 data bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
