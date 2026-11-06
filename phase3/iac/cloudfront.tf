# Phase 1's hand-created distribution, brought under state via `import`. It serves
# the whole site: the marketing root from S3, and `/blog*` from the Phase 3 origins
# (content bucket and HTTP API; see edge.tf for the behaviors).
# It is not gated by any deploy_* flag -- it always exists once imported.
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

# AllViewer without the Host header: the HTTP API routes by its own host name, so the
# viewer's Host must not be forwarded to it.
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

  # Phase 3 behaviors (deploy_phase3_edge): see edge.tf for the list and its order.
  dynamic "ordered_cache_behavior" {
    for_each = var.deploy_phase3_edge ? local.phase3_behaviors : {}
    content {
      path_pattern           = ordered_cache_behavior.value.pattern
      target_origin_id       = ordered_cache_behavior.value.origin
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ordered_cache_behavior.value.methods
      cached_methods         = ["GET", "HEAD"]
      compress               = true
      cache_policy_id = (
        ordered_cache_behavior.value.cache == "optimized" ? data.aws_cloudfront_cache_policy.caching_optimized.id :
        ordered_cache_behavior.value.cache == "origin" ? aws_cloudfront_cache_policy.origin_headers[0].id :
        data.aws_cloudfront_cache_policy.caching_disabled.id
      )
      origin_request_policy_id = (
        ordered_cache_behavior.value.request == "viewer" ? data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id :
        ordered_cache_behavior.value.request == "query" ? aws_cloudfront_origin_request_policy.query_only[0].id :
        null
      )

      dynamic "function_association" {
        for_each = ordered_cache_behavior.value.function == null ? [] : [ordered_cache_behavior.value.function]
        content {
          event_type   = "viewer-request"
          function_arn = function_association.value == "index" ? aws_cloudfront_function.index[0].arn : aws_cloudfront_function.anonymous_member[0].arn
        }
      }
    }
  }

  # Phase 1 marketing-root S3 origin (not part of this state). Its OAC ID
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

  # Phase 3 origins: the content bucket (read through its own access control)
  # and the HTTP API in front of every dynamic function.
  dynamic "origin" {
    for_each = var.deploy_phase3_edge ? [1] : []
    content {
      origin_id                = "s3-phase3-content"
      domain_name              = aws_s3_bucket.content[0].bucket_regional_domain_name
      origin_access_control_id = aws_cloudfront_origin_access_control.content[0].id
    }
  }

  dynamic "origin" {
    for_each = var.deploy_phase3_edge ? [1] : []
    content {
      origin_id   = "api-phase3"
      domain_name = local.api_domain

      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  # A size variant missing from the bucket fails over to the resizing function.
  # With listing granted a missing key is a 404; 403 stays in the list for safety.
  dynamic "origin_group" {
    for_each = var.deploy_phase3_edge ? [1] : []
    content {
      origin_id = "images-phase3"

      failover_criteria {
        status_codes = [403, 404]
      }

      member {
        origin_id = "s3-phase3-content"
      }

      member {
        origin_id = "api-phase3"
      }
    }
  }

  # The generator's rendered 404 page, with status 404. Applies to the whole
  # distribution: an API 404 gets the page too (accepted, tested in validation).
  dynamic "custom_error_response" {
    for_each = var.deploy_phase3_edge ? [1] : []
    content {
      error_code            = 404
      response_code         = 404
      response_page_path    = "/blog/404.html"
      error_caching_min_ttl = 10
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
