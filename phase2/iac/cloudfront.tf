# Phase 1's hand-created distribution, brought under state via `import`
# (Task 9's runbook runs the actual `tofu import`). It serves the whole
# site: the marketing root from S3, and `/blog*` from the EC2 VPC origin.
# It is not gated by any deploy_* flag -- it always exists once imported.
# `deploy_cloudfront` only switches which origin the /blog* behaviours
# point at, and adds the image behaviour.
#
# The managed cache/origin-request policies below are looked up by name
# rather than hardcoded by ID so no CloudFront resource ID needs to live
# in this tracked file. The identifiers that have no such lookup (VPC
# origin id, appserver private DNS, marketing-root OAC id, site ACM cert
# ARN) are no-default variables instead -- see variables.tf and
# .local-secrets.md ("Phase 2 CloudFront import" heading).
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

# Same as AllViewer but WITHOUT the Host header. Lightsail's container
# service routes by Host: handed the site's domain it has no matching
# service and answers 404, which is exactly how the first cutover attempt
# took /blog down while images (served from S3, not Lightsail) stayed up.
# Forwarding Host was right for the Phase 1 EC2 origin, whose nginx keyed on
# it, and is wrong for this one -- so the policy follows the flag.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
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
    origin_request_policy_id   = var.deploy_cloudfront ? data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id : data.aws_cloudfront_origin_request_policy.all_viewer.id
    path_pattern               = "blog/ghost/*"
    realtime_log_config_arn    = ""
    response_headers_policy_id = ""
    smooth_streaming           = false
    # See the blog/* behaviour below for why this is a ternary.
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
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    default_ttl                = 0
    field_level_encryption_id  = ""
    max_ttl                    = 0
    min_ttl                    = 0
    origin_request_policy_id   = var.deploy_cloudfront ? data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id : data.aws_cloudfront_origin_request_policy.all_viewer.id
    path_pattern               = "blog/members/*"
    realtime_log_config_arn    = ""
    response_headers_policy_id = ""
    smooth_streaming           = false
    target_origin_id           = var.deploy_cloudfront ? "lightsail-ghost-phase2" : "ghost-classic-appserver-vpc-origin"
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
  #
  # Points at the origin group below instead of the S3 origin directly --
  # see aws_cloudfront_origin_group.images_with_app_fallback for why (moth
  # f34h6): a size variant that's never been viewed through the app has no
  # object in S3 yet, and S3 (behind OAC, no ListBucket) 403s rather than
  # 404s for a missing key, so a plain S3 origin has no way to ever create
  # the variant.
  dynamic "ordered_cache_behavior" {
    for_each = var.deploy_cloudfront ? [1] : []
    content {
      path_pattern           = "blog/content/images/*"
      target_origin_id       = "images-with-app-fallback"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true
      cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id
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
    origin_request_policy_id   = var.deploy_cloudfront ? data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id : data.aws_cloudfront_origin_request_policy.all_viewer.id
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
    origin_request_policy_id   = var.deploy_cloudfront ? data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id : data.aws_cloudfront_origin_request_policy.all_viewer.id
    path_pattern               = "blog"
    realtime_log_config_arn    = ""
    response_headers_policy_id = ""
    smooth_streaming           = false
    target_origin_id           = var.deploy_cloudfront ? "lightsail-ghost-phase2" : "ghost-classic-appserver-vpc-origin"
    trusted_key_groups         = []
    trusted_signers            = []
    viewer_protocol_policy     = "redirect-to-https"
    grpc_config {
      enabled = false
    }
  }

  # Phase 1 EC2 VPC-origin -- REMOVED 2026-09-11. The Phase 1 instance was
  # terminated and the CloudFront VPC origin (vo_9dZLR0ZDlJGBe3m7LL7vht) was
  # deleted out-of-band as part of Phase 1 cost teardown; this block used to
  # be kept as deploy_cloudfront's rollback path, but that path is dead now
  # that the underlying VPC origin no longer exists -- keeping the origin
  # declared here would just make routine applies fight the real (already
  # cleaned up) state. deploy_cloudfront=false is no longer a valid rollback.

  # Phase 1 marketing-root S3 origin (not part of phase2 state). Its OAC ID
  # and its domain_name (which embeds a bucket name and region) are both
  # no-default variables for the same reason -- see variables.tf. origin_id
  # is left as the literal it already was: it is not derived from
  # domain_name, and changing an origin_id would re-create the behaviour
  # association above and break the empty-plan gate.
  origin {
    connection_attempts      = 3
    connection_timeout       = 10
    domain_name              = var.marketing_root_origin_domain
    origin_access_control_id = var.marketing_root_oac_id
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

  # Lets a size variant that's never been served before get generated on
  # first request instead of 403ing forever -- see the blog/content/images/*
  # behaviour above (moth f34h6). S3 is still the origin for every normal
  # request (a variant that already exists); the app is only ever hit on a
  # cache miss where S3 itself returned 403 (an object missing under an OAC
  # policy with no ListBucket comes back as 403, not 404). Only 403 is in
  # the failover list for now -- deliberately minimal, widen during testing
  # if a real gap shows up rather than guessing upfront. Both member origins
  # (s3-ghost-phase2-data, lightsail-ghost-phase2) only exist when
  # deploy_cloudfront = true (deploy_cloudfront requires deploy_lightsail =
  # true, see variables.tf), same gate as this group.
  dynamic "origin_group" {
    for_each = var.deploy_cloudfront ? [1] : []
    content {
      origin_id = "images-with-app-fallback"

      failover_criteria {
        status_codes = [403]
      }

      member {
        origin_id = "s3-ghost-phase2-data"
      }

      member {
        origin_id = "lightsail-ghost-phase2"
      }
    }
  }

  restrictions {
    geo_restriction {
      locations        = []
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn            = var.site_acm_certificate_arn
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
