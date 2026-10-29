# Phase 3: serverless, on demand

Goal: replace the Phase 2 always-on Lightsail container with Lambda functions
that run only when needed, so the expected Lambda cost is zero (free tier:
1M invocations, 400k GB-seconds/month) and S3/CloudFront cost is negligible.
Decision record: moth `nx54g`. This file holds the technical detail; the moth
issue stays decisions only.

Directory layout follows Phase 2: `iac/` (OpenTofu), `scripts/`, `packages/`
(per-function bundles and shared code), `docker/` or build tooling as needed.
Nothing is implemented yet; this document is the endpoint inventory and
function grouping the implementation will be planned from.

## Principles

- **Static public site.** Public pages are pre-rendered HTML in S3 behind
  CloudFront. No Lambda on the public read path in steady state.
- **One bundle per function.** Each function is built and trimmed to only what
  it needs and sized (memory = CPU) for its own work. No shared fat image.
- **Writes only through few functions.** Only functions that mutate data touch
  the sqlite-s3 store for writing; everything else is read-only or stateless.
- **Release invariant.** No page or newsletter is released until every image
  URL and srcset size in its HTML exists in S3.
- **Priority on content serving.** Account concurrency is shared (default
  1000). Functions on reader-facing paths get reserved concurrency; admin and
  background functions get a hard cap so they cannot starve readers.

## Source of the inventory

Derived from Ghost's own routers (fork submodule `Ghost/`): the frontend site
router, the Content API, the Admin API, the members app, the comments router,
the webmentions receiver, and the jobs/scheduler services. Counts are of
registered routes at time of writing and drift with Ghost upgrades.

## Endpoint inventory

### 1. No function (static, served from S3 by CloudFront)

| What | Notes |
|---|---|
| Rendered pages: posts, pages, home, tag/author archives, pagination | Produced by the generator (function G1) |
| RSS feeds, `sitemap.xml`, `robots.txt`, `llms.txt`, favicon, `/.well-known/` | Generator output |
| Theme assets, built admin client, uploaded images and their size variants | Static; variants eager per invariant |
| Search index JSON (`/search-index/posts`, `/search-index/tags`) | Generator emits it as a file; removes the need for a Content API call per search |

### 2. Reader-facing functions (priority concurrency)

No paid tier is planned. R5 and R6 stay in the inventory so Ghost's paid-subscription code paths remain supported, but they are not deployed and do not appear in the architecture diagram.

| ID | Endpoints | Read/write | Why separate |
|---|---|---|---|
| R1 `image-resize` | Size-variant fallback on S3 miss (bytes served directly, no redirect) | writes S3 | Needs image library; memory-heavy; spiky; nothing else shares its dependencies |
| R2 `link-redirect` | Newsletter click-tracking redirect (`/r/*`) | write (click event) | Hot after every newsletter send; tiny; must stay fast |
| R3 `members-session` | Members app: member read/update, session, identity/entitlement/integrity tokens, send-magic-link, verify-otc, signin via magic link, member email/newsletter/offers/suppression, announcement, site info, feedback, recommendation click/subscribe | mixed | Every signed-in page view calls it; small bundle without billing or admin code |
| R4 `comments` | Comments router: browse, counts, replies, add, edit, delete, like/dislike, report | mixed | Counts and browse are cacheable at the CDN; writes are rare |
| R5 `billing` (not deployed) | Stripe checkout, billing-portal and update sessions, subscription update and apply-offer, gift redeem | write | Needs the Stripe SDK only; low volume |
| R6 `stripe-webhook` (not deployed) | Stripe webhook receiver | write | Separate trust model (signature verification, no session); bursty and must not share concurrency with readers |
| R7 `webmentions` | Webmention receiver | write | Public write endpoint with its own rate limits; trivial |
| R8 `content-api` | Content API (posts, pages, authors, tags, settings, newsletters, tiers, offers, recommendations) | read-only | Used by third-party/widget clients with an API key; cacheable at the CDN. Kept by decision, though nothing uses it today |

### 3. Render functions (infrequent, heavy)

| ID | Endpoints / trigger | Why |
|---|---|---|
| G1 `generator` | Triggered by change events (publish, edit, delete, settings, theme change, scheduled publish). Renders pages through the theme engine from a read-only snapshot, runs the image-variant preflight, writes HTML to S3, invalidates stale CDN paths | Largest bundle (theme engine); long timeout; runs a few times a day at most |
| G2 `preview` | Draft preview (`/p/<uuid>`), email web view (`/email/<uuid>`), unsubscribe page | Dynamic, per-request render for content that can't be pre-generated; reuses the render bundle |

### 4. Admin functions (one user, low volume, cold starts acceptable)

The Admin API (~236 routes) is grouped by dependency weight, not by route count.
Single concurrency cap, low.

| ID | Endpoint families | Why grouped |
|---|---|---|
| A1 `admin-content` | posts, pages, tags, slugs, snippets, oembed, email previews, search-index, schedules, actions, redirects, custom theme settings | Editing path; the one that triggers the generator on writes |
| A2 `admin-audience` | members (incl. bulk and stats), labels, tiers, offers, newsletters, automations and automated emails, emails, comments moderation, feedback, recommendations, mentions, links, gifts, stats, tinybird | Audience and email management; pulls in mailer and Stripe-admin code |
| A3 `admin-site` | authentication, session, users, roles, invites, settings, config, site, integrations, webhooks, themes (list/activate), notifications, slack, identities, featurebase | Account and site configuration; small |
| A4 `admin-heavy` | uploads (images, media, thumbnails, files, posts import, routes), theme upload, members CSV import/export, db export/import/delete | Large request bodies and long runtimes; memory and timeout sized independently so they don't inflate A1-A3 |

### 5. Background functions (no HTTP caller)

Ghost's single process runs these on in-process timers; each becomes an event-
triggered function.

| ID | Replaces | Trigger |
|---|---|---|
| B1 `scheduled-publish` | In-process post scheduler | One-shot schedule created per scheduled post |
| B2 `email-send` | Batch email sending, email event processing | Invoked by a newsletter send; runs the image preflight first |
| B3 `maintenance` | Recurring jobs: expired comp cleanup, token cleanup, gift cleanup | Time-based schedule |
| B4 `sqlite-checkpoint` | Checkpoint/compaction and orphan sweep currently done in-process | Time-based schedule (see Open) |
| (dropped) | Update check, ping services that phone home | Not run |

## Initial sizing hypotheses

To be replaced by measurements once functions exist; sizing is a tuning loop,
not a design input.

| Class | Memory starting point | Timeout | Concurrency |
|---|---|---|---|
| Redirect, webhooks, webmentions | smallest | seconds | reserved, small |
| Session, comments, billing | small | seconds | reserved |
| Image resize | large (image library) | tens of seconds | reserved, capped |
| Generator, preview | large (theme engine) | minutes | capped at 1-2 |
| Admin A1-A3 | medium | tens of seconds | shared cap |
| Admin heavy A4 | large | minutes | capped at 1 |
| Background | per function | per function | capped |

Total reserved concurrency stays well below the 1000 account limit with
headroom for unreserved functions.

## Spike: Lambda web functions (2026-10-28, docs and registry research only)

Nothing was deployed; findings come from the AWS developer guide, the pricing
page, the CloudFormation reference, the provider registry and the provider's
issue tracker.

**Fit**
- Region: our region (us-east-1) is supported. Runtime is Node.js 24 on arm64
  only, zip packages from S3.
- Programming model: a plain HTTP server on the address in
  `AWS_LAMBDA_HTTP_ENDPOINT`, many concurrent requests per environment (up to
  128), request timeout up to 15 minutes. Ghost's Express app fits as is.
- Startup: the server must listen within 10 seconds; anything slower (Ghost
  boot, SQLite restore from S3) has to start after listening, with request
  handlers awaiting a shared "ready" promise.
- Shutdown: SIGTERM then 1 second. No guarantee it runs, so nothing may be
  persisted only at shutdown (relevant to the sqlite-s3 checkpoint).
- Docs are silent on whether CPU is frozen between requests, how long an idle
  environment lives, and whether work after the response completes. Must be
  measured before relying on in-process background work.

**Mismatches with the current design**
- **Fixed environment size.** Every environment is 2 GB / 2 vCPU. Per-function
  memory sizing ("just enough") is not possible; the only cost lever is how
  many environments exist and for how long.
- **Different scaling controls.** Account concurrency of 1000 and reserved
  concurrency do not apply. Control is per endpoint: `maxEnvironments`
  (minimum 2 when set), request `rateLimit`, and the account-wide 2000 vCPU
  quota (1000 environments). Priority for reader-facing paths becomes
  "admin and background endpoints get low caps", not reservations.
- **Pricing.** Per request $0.30/M; active CPU $0.0000276944/vCPU-second;
  memory $0.0000036667/GB-second for as long as the environment exists. The
  pricing page does not say the Lambda free tier (1M requests, 400k GB-s)
  applies to web functions, so the "zero cost" goal is unproven. Rough
  arithmetic, not a measurement: a single environment kept alive all month
  costs about $19 in memory alone, i.e. more than the Phase 2 container.
  Cost therefore depends on environments actually scaling to zero between
  uses.
- **Per-environment concurrency.** Fine for I/O-bound members/admin paths, but
  CPU-heavy work (generator, image resize) blocks the event loop of every
  request sharing the environment.

**IaC**
- Terraform/OpenTofu AWS provider: latest release is 6.70.0 and has no web
  function resources; the tracking issue was opened 2026-10-13 and is still
  open. Phase 2 pins the provider to 5.x, which will not get it either.
- CloudFormation does have the three resource types (web function, revision,
  endpoint). Escape hatch that stays declarative: manage them from OpenTofu
  through a CloudFormation stack resource. Alternative: CLI calls from a
  script, which loses drift detection.
- The local AWS CLI (2.33.2) has no `lambda-web` commands; needs upgrading
  (2.39.0 is current upstream).
- Endpoints can be CloudFront origins (IAM auth with origin access control);
  the provider's own support for that combination is also an open issue.

**Assessment**
Web functions suit the app-shaped, I/O-bound pieces (members session,
comments, admin) where running Ghost's Express code unmodified is the point.
Classic event-driven Lambda suits the small single-purpose pieces (redirect,
webhooks, webmentions, resize, generator, background jobs): per-function
memory sizing, reserved concurrency, free tier, and full provider support.

## Routing: path to function

All paths sit under the blog base path (`/blog`), as in Phase 2. One API
Gateway HTTP API fronts every dynamic function (readers, render, admin);
it maps method + path to a function and carries per-route throttling.
CloudFront matches on path only and decides S3 vs the API; cacheable GETs
(comment browse and counts, Content API, anonymous site info) are answered by
CloudFront and never reach the API. Default 25 behaviors per distribution.

| # | Pattern (after `/blog`) | Origin | Function | Cache |
|---|---|---|---|---|
| 1 | `/content/images/*` | S3; origin group fails over to the API on a miss | R1 `image-resize` | long |
| 2 | `/r/*` | API | R2 `link-redirect` | none |
| 3a | `/members/api/comments/counts*` | API | R4 `comments` | cached per the origin's own `public` header; no cookies forwarded, key is path + `ids` |
| 3b | `/members/*` (incl. the other comment routes) | API | R3 `members-session`, R4 `comments` | origin marks these private/no-store, so not cached; session cookie forwarded |
| 4 | `/webmentions/*` | API | R7 `webmentions` | none |
| 5 | `/ghost/api/content/*` | API | R8 `content-api` | short |
| 6 | `/ghost/api/admin/*` | API | A1-A4, see "Admin dispatch" | none |
| 7 | `/p/*`, `/email/*`, `/unsubscribe/*`, `/gift/*` | API | G2 `preview` | none |
| 8 | default `/*` | S3 static (pages, feeds, sitemap, search index, theme assets, media, files, built admin client, `/members/.well-known` key set emitted by the generator) | none | per object |

About 11 behaviors (row 7 is four patterns). Enabling R5/R6 (not planned)
adds routes on the API, not behaviors beyond the Stripe and webhook paths.

Background functions B1-B4 have no HTTP route.

### Why API Gateway for all dynamic functions

- Routing by method and path in one declarative table; no per-family CloudFront
  behaviors (about 45 Admin API families would not fit the behavior limit, and
  A1-A4 are not contiguous prefixes: `images/upload`, `media/upload`,
  `files/upload`, `themes/upload`, `members/upload`, `posts/upload`,
  `redirects/upload`, `db*`, `exports*` live inside other groups' families).
- Per-route rate and burst throttling is the spend control for public write
  endpoints (comments, magic links, webmentions). It is per route, not per
  client: one spammer can exhaust a route's budget (cost is capped, availability
  of that route is not). Per-client limits would need WAF, which is not planned
  (cost). Reserved concurrency on each function is a second, independent cap.
  A budget alarm covers the rest.
- Cacheable GETs are served by CloudFront, so they cost nothing at the gateway.
- No lock to CloudFront: API Gateway has no origin access control, and a shared
  secret header with an authorizer was judged not worth it. Ghost's own
  session auth guards admin; its brute-force limits stay in the functions.
- Costs: about $1 per million requests; 30-second integration timeout, so long
  admin work (imports, exports) is started from S3 events, not held open.

Rejected: Lambda function URLs with OAC for readers (free lock to CloudFront,
no per-route throttling, second routing mechanism); CloudFront Function
rewrite for admin (mapping must track Ghost upgrades); one admin function
routing internally.

Payload cap: Lambda request and response are limited to 6 MB, so uploads
(images, media, theme, imports) go through presigned S3 URLs, not through A4.
A4 then handles the processing, not the bytes. Bulk downloads follow the same
rule if needed (fix if hit).

## Storage layout and generator behavior

- **Two buckets.** A content bucket (generated HTML, feeds, search index,
  theme assets, images and variants) and the store bucket (database segments,
  manifest, leases). Object keys in the content bucket equal URL paths under
  `/blog`, so CloudFront passes the path through unchanged. Existing images
  are copied from the Phase 2 data bucket once at cutover (small).
  Rationale: the store is the only copy of the blog, so nothing that writes
  content has access to it, and CloudFront never reads it.
- **Index files.** An S3 origin does not serve a directory index, so a
  CloudFront Function maps a directory path to its `index.html` object.
- **Generator is idempotent and resumable.** It overwrites deterministic keys
  and can be re-run from the start at any point. Order of work: image variants
  first, then HTML, then invalidation, so an interruption leaves old pages or
  complete new pages, never a page that references a missing image.
- **Interruption is expected; a queue drives the generator.** Every change
  event (admin write, scheduled publish) enqueues a request; the generator is
  triggered from the queue. A run that fails or times out leaves its message
  to reappear after the visibility timeout (set above the generator timeout),
  with a bounded retry count and a dead-letter queue that raises an alarm.
  A burst of edits coalesces: one full re-crawl satisfies every pending
  request, so the generator drops queued duplicates after a successful run.
- **Invalidation: one wildcard over the blog path per run**, as the last step
  of the run. It does not depend on what changed, so an interrupted and
  retried run still ends with a full invalidation. Cost: images and feeds
  leave the cache too and refill from S3 (negligible at this size). Per-path
  invalidation was rejected: a run that dies after writing but before
  invalidating would, on retry, see nothing changed and leave stale pages
  cached. Revisit only if it becomes a problem.
- **HTML cache lifetime is long (about a day).** Freshness comes from the
  per-run invalidation, not from expiry. Rejected: a short lifetime as a
  backstop for failed invalidations (more origin traffic; the retried run
  already repeats the invalidation).
- **Cache keys (decided): the origin's Cache-Control decides.**
  Checked live (anonymous visitor): comment counts come back `public` and are
  not member-specific (Ghost registers the route before loading the member
  session), so that one route is cached without cookies, keyed by path and
  `ids`. Comment browse/read/replies, the member call (204 when anonymous) and
  the site info call all come back `private, no-store`, and browse carries
  per-comment liked/disliked state, so they are not cached and forward the
  session cookie. The cache policy honors origin headers with no TTL overrides.
  Static pages and assets and the Content API are cached without cookies;
  admin, link redirect and preview are not cached. The origin's counts cache
  lifetime is a Ghost config value (zero in Phase 2), to be set, not overridden
  at the CDN.
- **Deletes are rare** (the blog is mostly append). The generator only deletes
  keys it created and tracks; it never prunes by listing a prefix.

## Cutover from Phase 2

Copy-based, as in Phase 2, but without the downtime window: the old setup
keeps serving until the flip. Accepted: anything written to the old setup
after the database copy is not carried over (single author, no signups,
nothing scheduled), so no final re-sync.

1. Create the content and store buckets. Copy the images into the content
   bucket at their final keys; copy the database into the new store with
   Phase 2's seed and export tools. Secrets and the signing keys inside the
   database carry over, so member sessions, magic links and old newsletter
   tracking and unsubscribe links keep working.
2. Deploy the functions, the API, the queue and the alarms, with background
   schedules off. Run the generator to completion (idempotent, resumable).
3. Validate before touching the distribution: crawl the live URL list
   (sitemap and feeds) and compare status, redirects and content with the
   new site; an old tracked link and an old unsubscribe link; a member
   session carried over; admin login plus a draft create, read and delete
   with an image, plus the API-404 checks listed under the edge section. Budget alarm, dead-letter alarm and concurrency caps must
   be in place first.
4. Flip: apply the distribution change, then the wildcard invalidation, then
   switch the background schedules on.
5. Validate again through the live path.
6. Good: remove the Lightsail service. Keep the old data bucket and the
   image repository until the owner says otherwise (decided: keep). Bad: restore the
   distribution to the old origin; if the container was already removed,
   redeploy it from the infrastructure code against the pre-flip data.

**Infrastructure as code.** `phase3/iac` starts as a copy of `phase2/iac` and
becomes the source of truth. The distribution is imported into the new state
through the same empty-plan gate Phase 2 used. `phase2/` stays as a demo and
is not applied anymore: once the distribution is in the new state, Phase 2's
local backend configuration and cached state are deleted so it cannot be
applied by accident. Rollback after the container is removed runs from the
Phase 3 code, which keeps the Lightsail flag.

## Cost comparison (estimate from measured traffic)

Phase 2 baseline: about $12-13 a month, of which $10 is the container service
(the account is on the free trial for it today).

**Measured traffic** (CloudFront access logs, last 30 days to 2026-10-29):
about 33,000 requests to the whole distribution (more than half are bots
probing the root site and come back as errors), 8,300 under the blog path,
about 1,400 human page views, 730 image requests, 720 members-API calls (243
of them the member-session check, 349 comment counts) and about 2,700 admin
API calls (the owner editing). So dynamic traffic is a few thousand requests a
month, three orders of magnitude below the free allowances.

| Item | Phase 3 monthly | Notes |
|---|---|---|
| Lambda (all functions) | $0 | Perpetual free tier is 1M requests and 400k GB-seconds; this uses under 1% |
| API Gateway HTTP API | ~$0.005 | $1.00 per million requests (first 300M, us-east-1); ~4k requests; the first 1M a month is free for a new account's first 12 months |
| S3 (content + store) | ~$0.1-0.5 | Storage is a few tens of MB; requests from generator writes and cold-start restores |
| CloudFront | $0 incremental | Existing distribution, inside the always-free 1 TB and 10M requests; invalidations: one path per generator run |
| Queue (SQS), schedules | $0 | SQS is always free up to 1M requests a month; Scheduler has a 14M allowance |
| CloudWatch alarms and Lambda logs | ~$0-0.5 | Built-in Lambda metrics replace the custom boot metrics |
| Parameter Store, SNS | ~$0 | As today |
| CloudFront access logs (page stats) | ~$0.20 per 1M requests | Same in both phases; ~$0.007 at 33k |
| Old data bucket + image repository kept for rollback | ~$0.1-0.3 | Until the owner removes them |
| **Total** | **about $0.5-1.5** | vs **$12-13** |

Saving: about $11-12 a month, almost all of it the container service.
Headroom: traffic could grow a few hundred times before any line leaves its
free allowance. The unconfirmed number: the 1,000 free invalidation paths a
month (one path per run, so irrelevant at this scale).

**Considered and not pursued:** having a CloudFront Function answer the
anonymous member-session check itself. At 243 calls a month it saves nothing.

## Infrastructure as code

Same approach as Phase 2, as a copy that becomes the source of truth:
OpenTofu with the AWS provider pinned to 5.x, a versioned S3 remote backend
configured from a gitignored file, instance-specific values in gitignored
variable files and the exact resource identifiers only in `.local-secrets.md`,
one file per component (storage, IAM, functions, API, queue and schedules,
CloudFront, monitoring, access logs, outputs), and staged flags that default
off so infrastructure comes up in steps (buckets first, then functions and
API, the distribution change last). The existing distribution is imported
behind an empty-plan gate and stays undeletable. Function bundles are built
and trimmed per function and published as zip packages (no container image
or registry). Scripts mirror Phase 2's: deploy, verify (the draft roundtrip
check is reused), and the rollback path. Layout follows Phase 2:
`phase3/iac`, `scripts`, `packages`.

## Edge: directory indexes and the 404 page

- **Indexes.** A CloudFront Function on the static behavior (viewer request)
  appends `index.html` to paths ending in `/`, and redirects extension-less
  paths without a trailing slash (including bare `/blog`) to the slash version
  with a 301, as Ghost does. Paths with an extension pass through. The
  generator sets each object's content type when it writes it (feeds keep
  their feed type), and the static behavior's cache key ignores query strings
  and cookies. The built-in default root object cannot do this: it only covers
  the site root.
- **404 page (decided: distribution custom error response).** The generator
  renders the theme's 404 page to an object under the blog path; a custom
  error response maps 404 to it and returns status 404. Only 404 is mapped,
  and the content bucket grants the distribution listing so a missing key is a
  true 404 rather than a 403; the root site's own 403 is untouched. Error
  responses are configured per distribution, not per behavior, so a 404 from
  the API (Ghost returns JSON with status 404 for a missing resource) also
  gets the HTML page. Accepted; tested in validation: in the admin, open a
  deleted post and delete something, and in the comments widget, request a
  missing comment, confirming the clients still behave. Rejected: failover to
  a not-found function (extra route and function for the same result), and the
  raw storage error page (unfriendly).

## Decided after the spike

- **Classic Lambda for all functions** (including members-session, comments, admin: Express inside the function, behind one API Gateway HTTP API). Web functions are not used.
- Admin: four path families, one function each (A1-A4); uploads and theme upload routes are carved out of their natural families into A4.
- Checkpointing is awaited inside the write invocation (not fire-and-forget).
- Read freshness: readers check the manifest per request with a short time limit (about 30 seconds) before reusing a warm snapshot.
- Content API (R8) is kept as a read-only function, cacheable at the CDN, even though nothing in the repo uses it today.
- Dispatch: one API Gateway HTTP API in front of all dynamic functions (readers, render, admin), with per-route throttling; see Routing.
- Cold-start time is measured after the first deploy and sizing is adjusted then; no separate spike deploy.

## Open

- Generator deleting pages that no longer exist (rare): how it tracks the keys it owns.
- Presigned upload flow for the admin client.
