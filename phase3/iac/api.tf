# Phase 3 API (flag: deploy_functions). One HTTP API in front of every dynamic
# function CloudFront calls; it maps method and path to a function and carries
# per-route throttling (the spend control for public write endpoints). All
# paths sit under the blog base path, which CloudFront passes through
# unchanged. Nothing is wired to the distribution here.

locals {
  admin_base = "/blog/ghost/api/admin"

  # The Admin API's top-level families, assigned to the four admin functions by
  # dependency weight (see phase3/readme.md).
  admin_families = {
    admin-content  = ["posts", "pages", "tags", "slugs", "snippets", "oembed", "email_previews", "search-index", "schedules", "actions", "redirects", "custom_theme_settings"]
    admin-audience = ["members", "labels", "tiers", "offers", "newsletters", "automations", "automated_emails", "emails", "comments", "feedback", "recommendations", "mentions", "links", "gifts", "gift_links", "stats", "tinybird"]
    admin-site     = ["authentication", "session", "users", "roles", "invites", "settings", "config", "site", "integrations", "webhooks", "themes", "notifications", "slack", "identities", "featurebase"]
    # Uploads, imports and exports. More specific than the families above, so
    # they win where they sit inside another group's family (members/upload,
    # posts/upload, posts/export, redirects/upload, themes/upload).
    admin-heavy = ["images", "media", "files", "db", "exports", "members/upload", "posts/upload", "posts/export", "redirects/upload", "themes/upload"]
  }

  # Each base expands to two routes: the path and everything below it. API
  # Gateway rejects route keys ending in a slash, so the trailing-slash form
  # has to be matched by the wildcard (checked after the first deploy).
  route_bases = concat(
    [
      # The image behavior fails over here when an object is missing.
      { base = "/blog/content/images", fn = "image-resize" },
      { base = "/blog/r", fn = "link-redirect" },
      { base = "/blog/members", fn = "members-session" },
      { base = "/blog/members/api/comments", fn = "comments" },
      { base = "/blog/webmentions", fn = "webmentions" },
      { base = "/blog/ghost/api/content", fn = "content-api" },
      { base = "/blog/p", fn = "preview" },
      { base = "/blog/email", fn = "preview" },
      { base = "/blog/unsubscribe", fn = "preview" },
      { base = "/blog/gift", fn = "preview" },
    ],
    flatten([
      for fn, families in local.admin_families : [
        for f in families : { base = "${local.admin_base}/${f}", fn = fn }
      ]
    ]),
  )

  routes = merge(
    merge([
      for e in local.route_bases : {
        "ANY ${e.base}"          = e.fn
        "ANY ${e.base}/{proxy+}" = e.fn
      }
    ]...),
    # Anything else under the Admin API goes to the site group.
    { "ANY ${local.admin_base}/{proxy+}" = "admin-site" },
  )

  # Throttling per base (requests per second, burst). Tight on the public
  # write endpoints; the default below covers the rest.
  route_limits = {
    "/blog/members/api/comments" = { rate = 5, burst = 10 }
    "/blog/members"              = { rate = 10, burst = 20 }
    "/blog/webmentions"          = { rate = 1, burst = 2 }
    "/blog/r"                    = { rate = 20, burst = 40 }
  }

  throttled_routes = merge([
    for base, l in local.route_limits : {
      "ANY ${base}"          = l
      "ANY ${base}/{proxy+}" = l
    }
  ]...)

  active_routes      = var.deploy_functions ? local.routes : {}
  api_function_names = toset(values(local.active_routes))
}

resource "aws_apigatewayv2_api" "site" {
  count = var.deploy_functions ? 1 : 0

  name          = "ghost-phase3"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "function" {
  for_each = local.api_function_names

  api_id                 = aws_apigatewayv2_api.site[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.function[each.key].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "route" {
  for_each = local.active_routes

  api_id    = aws_apigatewayv2_api.site[0].id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.function[each.value].id}"
}

resource "aws_lambda_permission" "api" {
  for_each = local.api_function_names

  statement_id  = "AllowApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.function[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.site[0].execution_arn}/*/*"
}

resource "aws_apigatewayv2_stage" "default" {
  count = var.deploy_functions ? 1 : 0

  api_id      = aws_apigatewayv2_api.site[0].id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = 20
    throttling_burst_limit = 40
  }

  dynamic "route_settings" {
    for_each = local.throttled_routes
    content {
      route_key              = route_settings.key
      throttling_rate_limit  = route_settings.value.rate
      throttling_burst_limit = route_settings.value.burst
    }
  }

  depends_on = [aws_apigatewayv2_route.route]
}
