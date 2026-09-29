Symptom: the first request for a responsive image size variant that isn't
in S3 yet (e.g. size/w1200 or size/w1920 of a freshly uploaded image) ends
in a browser redirect loop (Firefox: NS_ERROR_REDIRECT_LOOP). Seen
2026-09-29 on the flappy.png header of the "do androids dream of flappy
birds" draft.

Root cause: follow-up gap in the f34h6 app-fallback design. On a missing
variant S3 answers 403, CloudFront fails over to Ghost, Ghost's image-size
middleware generates and saves the variant, then hands off to
S3Storage.serve(), which always answers a 301 to `${cdnUrl}/${key}`.
cdnUrl is the site's own public origin, so the 301 points at the exact URL
just requested. The redirect carries no Cache-Control, so CloudFront
(CachingOptimized) and the browser both cache it, and every follow-up
request replays the cached 301 to itself. Confirmed via CloudFront access
logs (one 301 Miss followed by a burst of 301 Hits in the same second) and
by direct origin requests (every image path 301s to itself on the public
host).

Mitigation applied 2026-09-29: CloudFront invalidation of
/blog/content/images/size/* -- affected variants now serve 200 from S3.
Does not prevent recurrence for the next new image.

Decision (option A): patch S3Storage.serve() from the launcher (same
approach as the existing database-info patch -- runtime patch, Ghost fork
untouched) so its redirect is a 302 with Cache-Control: no-store. Neither
CloudFront nor the browser caches it; the retried request hits the
now-existing S3 object and gets a 200.
Why: smallest change that fixes the cause; keeps the Ghost submodule
unmodified; no extra infrastructure.

Rejected:
- Serving the generated image bytes directly from the fallback instead of
  redirecting -- one round trip fewer, but means overriding more of
  Ghost's middleware than a single adapter method.
- Lambda@Edge rewriting self-redirects -- extra infrastructure to paper
  over an app-level bug.
- Query-string cache busting on the redirect target -- CachingOptimized
  ignores query strings, so the cache key is unchanged and the loop stays.

Out of scope: eager variant generation at upload time; changing the
f34h6 failover design itself.


----- AI agent updates -------

Decision refined during implementation (2026-09-29): the replacement
redirect targets the full-size original, not the requested URL itself.
Why: CloudFront's image cache policy (managed CachingOptimized) has a 1s
MinTTL, and a MinTTL above zero makes CloudFront cache even a no-store
response for that long. A 302-to-self would therefore still loop for up to
a second, and the access logs showed browsers burning through their
redirect limit within a single second. A redirect to a different URL
(the original) cannot loop regardless of cache policy.
Trade-off accepted: the first viewer of each new variant receives the
full-size original once; every later request gets the variant from S3.

Rejected at this point:
- 302-to-self with no-store plus a custom image cache policy with MinTTL 0
  -- works, but needs an infra change and two coordinated pieces to stay
  in sync.

Behaviour of the patched serve():
- size-variant path (with or without a format segment): uncacheable 302
  to the original image URL, derived the same way Ghost's own image-size
  middleware derives it.
- any other path: falls through to Ghost's normal handling (404) instead
  of redirecting to itself -- same bug class, e.g. an original missing
  from S3.

Implementation approach: runtime patch applied by the launcher preload
(Ghost fork untouched), replacing S3Storage's serve() on the class Ghost's
adapter manager loads. Applied after all config overrides because the
adapter module pulls in logging, which reads config when first loaded.
Patch failure is logged and non-fatal: the site keeps working, only new
variants can loop again.

Out of scope (noted): Ghost's media and files storage use the same
S3Storage class, so the patch applies to them as well: previously they
redirected to themselves (a loop), now they 404. They are not in use on
this site; making them actually serve from S3 is left for if they ever
are.

Operational workaround until deployed: after the first view of a new
post, invalidate the image size-variant paths on CloudFront before
sending the newsletter.


Why rw2qy (f34h6) didn't catch this: its live check used a client that
doesn't follow redirects and accepted "first request redirects, second
request 200" as success. It never checked where the redirect pointed (the
same URL) or whether a redirect-following client ever reaches the image,
and a single probe lands on only one of the cache entries CloudFront keeps
per Accept-Encoding, so a looping entry can coexist with a healthy one.

Post-deploy verification (manual, per deploy): a script in phase2/scripts
(verify-image-variants.sh) takes one existing image, two never-generated
size variants and one already-generated variant. It refuses to run unless
the fresh variants are absent from S3 (requesting a variant generates it
permanently, so each run needs new ones -- hence manual, not a deploy
gate). It checks: the first request answers an uncacheable redirect to the
original, never to itself; a repeat answers 200 (or the same redirect
within the 1s MinTTL window); a redirect-following client reaches the
image in at most one hop under several Accept-Encoding values; generated
variants land in S3; an existing variant still serves directly; a missing
original 404s; a size the theme doesn't allow still redirects to the
original. Beyond the script: a real-browser preview of a freshly uploaded
image, a test newsletter opened in Apple Mail/iOS, and a day of access
logs showing no 301s on size-variant paths.


Deployed 2026-09-29 (image tag 11e38b5, via the standard deploy
pipeline; Lightsail deployment ACTIVE). Post-deploy verification run by
the user and reported passing. Note for future runs of the check: the
fresh sizes must be ones the active theme allows -- a size outside the
theme's list is redirected to the original by Ghost itself and never
generated, so it can't exercise the fallback (and fails the "landed in
S3" check).


----- Closeout -----

Validated: launcher unit tests pass (including the serve() patch tests),
shellcheck clean on the post-deploy check script. Deployed to prod
(image 11e38b5) and verified post-deploy by the user. Merged to main
(merge db70616 of branch a1jxt-image-redirect-loop). Closed by the user
2026-09-29.
