# Phase 3 edge stage (flag: deploy_phase3_edge, default off). Switches the /blog
# behaviors of the live distribution from the Lightsail container to the Phase 3
# origins: the content bucket (pages, feeds, assets, images) and the HTTP API
# (every dynamic function). Applying this is the cutover flip; see
# phase3/readme.md ("Cutover from Phase 2") for what must be true first.

# Query strings only: no cookies, no headers (comment counts, Content API).
resource "aws_cloudfront_origin_request_policy" "query_only" {
  count = local.edge_shared ? 1 : 0

  name = "ghost-phase3-query-only"
  cookies_config { cookie_behavior = "none" }
  headers_config { header_behavior = "none" }
  query_strings_config { query_string_behavior = "all" }
}

# Cache lifetime comes from the origin's own Cache-Control; no cookies or
# headers in the key, query strings included (the counts' ids, the API key).
resource "aws_cloudfront_cache_policy" "origin_headers" {
  count = local.edge_shared ? 1 : 0

  name        = "ghost-phase3-origin-headers"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 31536000
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "all" }
  }
}

resource "aws_cloudfront_origin_access_control" "content" {
  count = local.edge_shared ? 1 : 0

  name                              = "ghost-phase3-content"
  description                       = "Lets the site distribution read the Phase 3 content bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# The distribution reads objects and lists the bucket: with listing granted, a
# missing key is a true 404 (the 404 page below) rather than a 403.
data "aws_iam_policy_document" "content_read" {
  count = local.edge_shared ? 1 : 0

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.content[0].arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = local.content_readers
    }
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.content[0].arn]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = local.content_readers
    }
  }
}

resource "aws_s3_bucket_policy" "content" {
  count = local.edge_shared ? 1 : 0

  bucket = aws_s3_bucket.content[0].id
  policy = data.aws_iam_policy_document.content_read[0].json
}

# Directory indexes and slash redirects for the static behavior: a path ending
# in / maps to its index.html object; an extension-less path without a trailing
# slash gets a 301 to the slash form, as Ghost does; the bare base path too.
resource "aws_cloudfront_function" "index" {
  count = local.edge_shared ? 1 : 0

  name    = "ghost-phase3-index"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var r = event.request;
      var uri = r.uri;
      var qs = '';
      var q = r.querystring;
      var keys = Object.keys(q);
      if (keys.length) {
        qs = '?' + keys.map(function (k) { return q[k].multiValue ? q[k].multiValue.map(function (m) { return k + '=' + m.value; }).join('&') : k + '=' + q[k].value; }).join('&');
      }
      if (uri === '/blog' || (uri.slice(-1) !== '/' && uri.split('/').pop().indexOf('.') === -1)) {
        return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: uri + '/' + qs } } };
      }
      if (uri.slice(-1) === '/') r.uri = uri + 'index.html';
      return r;
    }
  JS
}

# A visitor without Ghost's members session cookie is anonymous, and Ghost
# answers that with an empty 204; answer it here so no function boots for it.
resource "aws_cloudfront_function" "anonymous_member" {
  count = local.edge_shared ? 1 : 0

  name    = "ghost-phase3-anonymous-member"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var r = event.request;
      if (r.method === 'GET' && !(r.cookies && r.cookies['ghost-members-ssr'])) {
        return { statusCode: 204, statusDescription: 'No Content', headers: { 'cache-control': { value: 'private, no-store' } } };
      }
      return r;
    }
  JS
}

locals {
  content_readers = compact([
    var.deploy_phase3_edge ? aws_cloudfront_distribution.site.arn : "",
    var.deploy_phase3_test_edge ? aws_cloudfront_distribution.phase3_test[0].arn : "",
  ])

  # The shared pieces exist for the live flip and for the test distribution alike.
  edge_shared = var.deploy_phase3_edge || var.deploy_phase3_test_edge

  api_domain = local.edge_shared ? replace(aws_apigatewayv2_api.site[0].api_endpoint, "https://", "") : ""

  all_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
  read_only   = ["GET", "HEAD"]

  # Precedence order is the key order (CloudFront matches in the listed order).
  # Patterns are written without the leading slash, as in the existing behaviors.
  phase3_behaviors = {
    "01-images"      = { pattern = "blog/content/images/*", origin = "images-phase3", methods = local.read_only, cache = "optimized", request = null, function = null }
    "02-link"        = { pattern = "blog/r/*", origin = "api-phase3", methods = local.read_only, cache = "disabled", request = "viewer", function = null }
    "03-counts"      = { pattern = "blog/members/api/comments/counts*", origin = "api-phase3", methods = local.read_only, cache = "origin", request = "query", function = null }
    "04-member"      = { pattern = "blog/members/api/member*", origin = "api-phase3", methods = local.all_methods, cache = "disabled", request = "viewer", function = "anonymous" }
    "05-session"     = { pattern = "blog/members/api/session*", origin = "api-phase3", methods = local.all_methods, cache = "disabled", request = "viewer", function = "anonymous" }
    "06-members"     = { pattern = "blog/members/*", origin = "api-phase3", methods = local.all_methods, cache = "disabled", request = "viewer", function = null }
    "07-webmentions" = { pattern = "blog/webmentions/*", origin = "api-phase3", methods = local.all_methods, cache = "disabled", request = "viewer", function = null }
    "08-content-api" = { pattern = "blog/ghost/api/content/*", origin = "api-phase3", methods = local.read_only, cache = "origin", request = "query", function = null }
    "09-admin-api"   = { pattern = "blog/ghost/api/admin/*", origin = "api-phase3", methods = local.all_methods, cache = "disabled", request = "viewer", function = null }
    "10-preview"     = { pattern = "blog/p/*", origin = "api-phase3", methods = local.all_methods, cache = "disabled", request = "viewer", function = null }
    "11-email"       = { pattern = "blog/email/*", origin = "api-phase3", methods = local.all_methods, cache = "disabled", request = "viewer", function = null }
    "12-unsubscribe" = { pattern = "blog/unsubscribe/*", origin = "api-phase3", methods = local.all_methods, cache = "disabled", request = "viewer", function = null }
    "13-gift"        = { pattern = "blog/gift/*", origin = "api-phase3", methods = local.all_methods, cache = "disabled", request = "viewer", function = null }
    "14-static"      = { pattern = "blog/*", origin = "s3-phase3-content", methods = local.read_only, cache = "optimized", request = null, function = "index" }
    "15-static-base" = { pattern = "blog", origin = "s3-phase3-content", methods = local.read_only, cache = "optimized", request = null, function = "index" }
  }

  # The admin client is not hosted by Phase 3 yet: while the container service
  # exists, its paths keep going there (after the admin API route above it).
  phase3_behavior_set = merge(local.phase3_behaviors, var.deploy_lightsail ? {
    "095-admin-ui" = { pattern = "blog/ghost/*", origin = "lightsail-ghost-phase2", methods = local.all_methods, cache = "disabled", request = "viewer", function = null }
  } : {})
}

# A separate distribution, reachable only by its own *.cloudfront.net address,
# with the same Phase 3 behaviors and functions as the live flip would give.
# It lets the edge be tested end to end (directory indexes, the 404 page, the
# anonymous member check, image failover, cache headers) while the live
# distribution keeps serving from the container. Pages it serves still carry
# the real site address in their links.
resource "aws_cloudfront_distribution" "phase3_test" {
  count = var.deploy_phase3_test_edge ? 1 : 0

  comment             = "ghost phase3 edge test (not live)"
  enabled             = true
  http_version        = "http2"
  is_ipv6_enabled     = true
  price_class         = "PriceClass_100"
  wait_for_deployment = true

  origin {
    origin_id                = "s3-phase3-content"
    domain_name              = aws_s3_bucket.content[0].bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.content[0].id
  }

  origin {
    origin_id   = "api-phase3"
    domain_name = local.api_domain

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin_group {
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

  default_cache_behavior {
    target_origin_id       = "s3-phase3-content"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.phase3_behaviors
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

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/blog/404.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

output "phase3_test_edge_domain" {
  value = var.deploy_phase3_test_edge ? aws_cloudfront_distribution.phase3_test[0].domain_name : null
}
