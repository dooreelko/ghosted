we need a split cloudfront origin for images so that when missing in s3, cloudfront hits ghost, image is generated and then it's back to s3

----- AI agent updates -------

Implemented (moth f34h6, now superseded by this ticket -- same fix,
merged to main).

Root cause: Ghost generates responsive image size variants (e.g.
size/w1920) lazily on first GET, not eagerly at upload time. In prod,
CloudFront's blog/content/images/* behavior pointed straight at the S3
data-bucket origin, bypassing the app entirely. Any size variant never
first-viewed through the app had no S3 object to serve -- S3 (behind
OAC, no ListBucket) returns 403 for a missing key rather than a
distinguishable 404, and nothing ever triggered generation. Confirmed
against a real, never-warmed image before the fix (403, no S3 object)
and after (first request: 301 as the app generates+saves+redirects;
second request: 200 straight from S3).

Decision: fixed via CloudFront origin group failover, not an app-code
change. The blog/content/images/* behavior's origin is now an
origin_group: primary = the S3 data-bucket origin, secondary =
the Lightsail app origin, failover_criteria.status_codes = [403] only
(deliberately minimal; widen to include 404/5xx later if testing shows
a real gap -- not speculatively). Gated the same way the existing image
behavior already was: only exists when deploy_cloudfront = true (which
already requires deploy_lightsail = true, so the app-origin member
always exists when the group does).

On a cache miss: S3 403s -> CloudFront fails over to the app -> Ghost
lazy-generates + saves the variant to S3 + redirects to canonical URL
-> subsequent requests are served straight from S3 again (no ongoing
perf cost after first view).

Out of scope (unchanged): eager size-variant generation at upload time
(rejected in favor of no app-code change); widening the failover status
code list beyond 403 upfront.

Implementation abstract: added an origin_group block inside the
existing aws_cloudfront_distribution resource (phase2/iac/cloudfront.tf),
referencing the two origin_ids that already existed (s3-ghost-phase2-data,
lightsail-ghost-phase2), and repointed the images ordered_cache_behavior's
target_origin_id at the new group instead of the S3 origin directly. No
new resources beyond that block, no app-code changes.

----- Closeout -----

Validated: `tofu validate` clean, `tofu fmt -check` clean (no diff).
Deployed to prod (tofu apply), live-tested against a real never-warmed
image (blog/content/images/size/w1920/2026/09/Equal_Earth_projection_SW.jpg):
before deploy 403 public / no S3 object; after deploy first request 301
(app generated + saved + redirected), second request 200 straight from
S3. Merged to main (commit 71be251 on branch
f34h6-cdn-image-origin-failover).
