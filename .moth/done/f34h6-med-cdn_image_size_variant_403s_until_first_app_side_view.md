Symptom: header/inline images published on the site 403 at the CDN when a
specific responsive size variant (e.g. size/w1920) is requested, even
though the original uploads fine and shows during editing. Confirmed on
https://the-well-architected-cloud.com/blog/content/images/size/w1920/2026/09/hq720.webp

Root cause: Ghost generates responsive size variants lazily on first GET
(image-transform middleware), not eagerly at upload time. In prod,
CloudFront's `blog/content/images/*` behavior (phase2/iac/cloudfront.tf)
points straight at the S3 data-bucket origin, bypassing the Lightsail app
entirely. So any size variant never first-viewed through the app (only
ever requested via the public CDN path) has no S3 object to serve --
S3 (behind OAC, no ListBucket) returns 403 instead of a distinguishable
404, and nothing ever triggers generation.

Confirmed by manually hitting the Lightsail app origin directly for the
missing w1920 key -- Ghost generated it, saved to S3, 301-redirected to
the canonical URL, which then served 200 from S3 on the next request.
That was a one-off manual unblock for the specific image above, not a
fix.

Decision: fix via CloudFront origin group failover, not app-code change.
Change the `blog/content/images/*` ordered_cache_behavior's origin to an
aws_cloudfront_origin_group: primary = the existing S3 data-bucket origin
(s3-ghost-phase2-data), secondary = the Lightsail app origin
(lightsail-ghost-phase2), failover_criteria.status_codes = [403] only
(minimal set; widen to include 404/5xx during testing if needed -- not
speculatively upfront). Gated the same way the current image behavior
already is (only present when deploy_cloudfront = true) -- doesn't apply
pre-cutover, no other state where this origin exists to fail over to.

On a cache miss: S3 403s -> CloudFront retries the app origin -> Ghost
lazy-generates + saves the variant to S3 + redirects -> subsequent
requests are served straight from S3 again (no ongoing perf cost after
first view).

Out of scope: eager size-variant generation at upload time (alternative
approach, rejected here in favor of no app-code change); widening the
failover status code list beyond 403 (defer to testing).

Testing: request a never-before-viewed size variant of a real image via
the public domain; confirm first hit fails over to the app and gets
generated, second hit serves 200 straight from S3.
