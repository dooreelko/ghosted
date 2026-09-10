deploy.sh reads the Lightsail service URL (tofu output public_url) and
verify.mjs's http-smoke-test hits ${lightsail}/blog/ and
${lightsail}/blog/ghost/ -- neither goes through CloudFront. Only the
image-fetch check (added after the bucket-policy incident) reaches
CloudFront, via Ghost's own configured CDN URL. So a CloudFront-side
/blog* regression -- a wrong origin_request_policy re-forwarding Host
(exactly what took the blog down during cutover, see moth i8hlt), a
behaviour retargeted to the dead EC2 origin, a deploy_cloudfront mishap --
passes verification cleanly. The i8hlt incident patched the image half of
this gap but not the HTML half.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: also smoke-test the real public domain
(https://the-well-architected-cloud.com/blog/) through CloudFront, not just
the direct Lightsail URL, or explicitly document why that's intentionally
out of scope if it turns out to be a deliberate choice.
