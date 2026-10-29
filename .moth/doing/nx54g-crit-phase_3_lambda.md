phase 3 is about turning the ghost in a proper serverless solution that only runs on demand, only parts that it needs and costs as little as possible. given aws gives free 400k GB/seconds each month (1 mil invocations), the expected cost should be zero on lambda and negligible on s3 & co

the approach is likely to decompose ghost's central express router into individual routes and map them to individual lambda functions. depending on the number we might group several routes together - admin, public, etc. we need to decide on the numbers. by default all functions share a max concurrent limit of 1000, so we should be below that prioritizing the content serving.

i already criticized lambda web functions as non cloud-native, but it's there anyway https://aws.amazon.com/blogs/aws/announcing-aws-lambda-web-functions-for-fast-consistent-web-app-performance-anywhere/

the catch is that neither og terraform nor tofu currently support it (needs checking and maybe an escape hatch).




----- AI agent updates -------

## Decisions (session 1, in progress)

**Shape: public site is static, Ghost only runs on demand for everything else.**
Public pages are pre-rendered HTML in S3 served by CloudFront; no Lambda sits
on the public read path in steady state.
- Production mechanism: **crawl-on-publish**. On any content/settings change
  (publish, edit, delete, settings) a generator function renders pages from a
  read-only Ghost render path and writes HTML to S3. Full re-crawl is
  acceptable (tiny blog), so no page-dependency map is needed.
- Rejected: CloudFront cache + invalidation with a read-only Ghost Lambda as
  origin -- readers would hit cold starts after every invalidation and there
  is no natural hook for the image preflight below.
- Rejected: hybrid S3-primary / Lambda-render failover -- not chosen; may be
  revisited if a scheduled-publish race shows up.

**Dynamic features are all kept** (comments, member signup/login, paid
subscriptions, search), as client-side calls from the static HTML to small
on-demand API functions. Rejected: dropping subscriptions/members to cut
functions.

**Decomposition: many small functions, each with its own purpose-built
bundle.** Not one shared image deployed N times: each function is built and
trimmed to only the code it needs and sized (CPU/memory) to just what it
needs. A concrete endpoint inventory (grouped by function, with sizing
rationale) is a required output of this task. Public/content serving gets
priority on the shared concurrency pool (account default 1000); total
reserved concurrency must stay below it.

**DB: public reads never touch the DB at request time** (static HTML, plus
read-only access via a snapshot from S3 for the render path). Writes happen
only through the admin/API functions on the existing sqlite-s3 store. Exact
snapshot freshness semantics: open.

**Image variants: eager, not lazy (reverses the `a1jxt` exclusion).**
Invariant: nothing is released until every image URL and srcset size in its
HTML exists in S3. Applies to both static pages (generator forces variant
generation, verifies S3, then publishes HTML and invalidates stale CDN
entries) and newsletter sends (preflight on the email HTML; refuse to send if
any is missing). Why: lazy generation (`rw2qy`, `a1jxt`) fails exactly where
mail clients fetch blindly with no retry. A resize function remains only as
a fallback for unknown/old URLs and serves bytes directly -- no redirect.
- Rejected: keeping lazy generation and relying on the fallback alone.

**Runtime/IaC: undecided, spike first.** Lambda web functions are Node 24 /
arm64 only, 5 regions, and have no tofu/terraform provider support (needs
checking, may need a CLI escape hatch). Spike decides web functions vs
classic Lambda, and region fit.

## Open
- Endpoint inventory and function grouping.
- Background work with no HTTP trigger (scheduled posts, email sending,
  jobs, webhooks): needs an on-demand trigger model.
- Read-snapshot freshness; how the generator reaches a read-only Ghost.
- Cutover from Phase 2 Lightsail; cost target stays ~zero on Lambda.


## Function grouping (proposed, pending confirmation)

Full inventory and sizing rationale: `phase3/readme.md`. Work for this phase
lives under `phase3/`, laid out like `phase2/`.

Groups, by dependency weight rather than route count:
- No function: all public pages, feeds, sitemap, theme assets, images and
  variants, search index (generated files in S3).
- Reader-facing, priority concurrency: image resize, newsletter link
  redirect, members session, comments, billing, Stripe webhook, webmentions,
  (optional) Content API.
- Render, rare and heavy: generator, and a preview/unsubscribe renderer.
- Admin, one user, capped concurrency: content, audience, site config, and a
  separate heavy group for uploads and import/export.
- Background (replacing Ghost's in-process timers): scheduled publish, email
  send, maintenance, checkpoint.

Rejected: one function per Admin API route (~236) -- no benefit for a single
admin user and each extra function adds a DB restore on cold start; split
only where memory/timeout profile differs (hence the separate heavy group).
Dropped: update-check and other phone-home jobs.


## Spike result: web functions (research only, nothing deployed)

Detail in `phase3/readme.md`. Findings that bear on the decision:
- Region is supported; Ghost's Express app would run unmodified.
- Environments are a fixed size, so per-function CPU/memory sizing is not
  possible; scaling is capped per endpoint, not by reserved concurrency.
- Free-tier applicability is unconfirmed, and a permanently warm environment
  would cost more than Phase 2. The zero-cost goal is unproven.
- No tofu/terraform provider support yet (tracking issue open); a
  CloudFormation stack driven from OpenTofu is the declarative escape hatch.

Leaning (not decided): classic Lambda for the small single-purpose functions,
web functions only where running Ghost's Express code whole is the point
(members session, comments, admin). Decision pending.


**Decisions (session 2)**
- Runtime: classic Lambda for every function; Lambda web functions are not
  used (fixed 2 GB sizing, unproven free tier, no provider support). Cold
  start is measured after the first deploy and sizing adjusted then.
- Paid tier: none planned. Billing and Stripe-webhook functions are kept in
  the design so Ghost's paid-subscription logic stays supported, but they are
  not deployed and not in the architecture diagram. This supersedes "paid
  subscriptions" in the dynamic-features decision above for deployment.
- Answered from Phase 2 records: multiple concurrent writers are already
  supported by the store (conditional manifest write, conflict detection),
  so several write functions are safe. The Phase 2 checkpoint is fire-and-
  forget from the commit path and cannot be relied on once Lambda freezes
  after the response; it must complete inside the invocation or run as its
  own scheduled function.
- Still open: admin function split (path families vs one routing function),
  read snapshot freshness, Content API use, CloudFront routing under the
  blog base path, cutover from Phase 2 and cost comparison.


**Decisions (session 2, continued)**
- Admin: four path families, one function per group (content, audience,
  site, heavy). Rejected: one admin function routing internally.
- Checkpointing is awaited inside the write invocation. Rejected: leaving it
  fire-and-forget as in Phase 2.
- Read freshness: readers re-check the manifest with a short time limit
  before reusing a warm snapshot.
- Still open: Content API use, CloudFront routing under the blog base path,
  cutover from Phase 2 and cost comparison.

- Content API function kept (read-only, CDN-cacheable), although nothing
  uses it today. Rejected: dropping it. Still open now: CloudFront routing
  under the blog base path, cutover from Phase 2 and cost comparison.

- Admin dispatch: one CloudFront behavior to an API Gateway HTTP API that
  maps each admin route to its group function. Rejected: CloudFront Function
  rewrite (mapping must track Ghost upgrades), one admin function routing
  internally. Large uploads go via presigned S3 URLs because of the Lambda
  payload cap.

- Function count: grouping stays (about 14 functions). Full per-route
  decomposition (about 300 functions) rejected: Ghost's service layer, not
  Express, is the weight, so every function would still pay the full cold
  start and DB restore.
- Lambda's 6 MB cap applies to responses as well as requests. Bulk bytes
  are served from S3 (static content, presigned links), not by functions.
  Known edge cases (admin exports, oversized image originals) are not
  designed up front; fix them if hit.



## Current state (supersedes earlier sections where they differ)

- Settled: static public site via crawl-on-publish; eager image variants;
  classic Lambda for every function; the grouped function set (reader-facing,
  render, admin x4, background), confirmed; one API Gateway HTTP API in front
  of the admin groups; shared sqlite-s3 store with writes only through
  admin/background functions and awaited checkpoints; reads re-check the
  manifest on a short time limit; Content API function kept; no paid tier
  (billing and webhook functions designed but not deployed).
- No longer open from session 1: endpoint inventory, grouping, runtime
  choice, background trigger model (schedules plus function-to-function
  invocation), snapshot freshness.
- Still open: CloudFront routing under the blog base path and how generator
  invalidations interact with it (proposal in `phase3/readme.md`, "Routing"),
  cutover from Phase 2, cost comparison, and the OpenTofu layout for phase 3.
- The architecture diagram is kept current in `phase3/` (clarc source,
  drawio, png) and is updated whenever a decision above changes.



**Decision (session 2, later): one API Gateway HTTP API in front of every
dynamic function (readers, render, admin).** Supersedes "admin only" above
and the function-URL mix for readers.
- Why: single declarative method+path routing; per-route rate/burst
  throttling is the spend control for public write endpoints, and CloudFront
  answers cacheable GETs so those never reach the gateway.
- Accepted limits: throttling is per route, not per client (a spammer can
  exhaust a route's budget; cost stays capped); no origin lock to CloudFront
  (not supported by the gateway; a shared-secret authorizer judged not worth
  it, Ghost session auth guards admin); about $1 per million requests; 30 s
  integration timeout, so long admin work is started from storage events.
- Spend control overall: per-route throttling, reserved concurrency per
  function, and a budget alarm. WAF not used (cost).
- Rejected: Lambda function URLs with origin access control for readers
  (free lock, but no per-route throttling and a second routing mechanism).


**Correction to "Current state":** the API Gateway HTTP API fronts every
function that CloudFront calls (readers, render preview, admin), not only the
admin groups. Background functions have no HTTP route; schedules and other
functions invoke them.



**Decisions (session 3): storage and generator**
- Two buckets: a content bucket (generated pages, feeds, images and
  variants) and the store bucket (database only). Object keys equal URL paths
  under the blog base path. Why: the store is the only copy of the blog, so no
  content writer may reach it and the CDN never reads it. Rejected: one shared
  bucket with prefix-scoped permissions (guarantees depend on policy
  discipline); the one-off image copy at cutover is cheap.
- The generator is idempotent and safely re-runnable at any point: images
  first, then pages, then invalidation, so an interruption never leaves a page
  pointing at a missing image. Pipeline retries interrupted runs.
- Deletes are rare (blog is mostly append). The generator only removes keys it
  created and tracks; never prunes by listing a prefix.
- Still open: retry mechanism for interrupted runs, tracking of owned keys
  for deletion, CloudFront cache keys and invalidation scope, cutover from
  Phase 2, cost comparison, OpenTofu layout.


- Generator retries: a queue sits in front of the generator; admin writes
  and scheduled publishes enqueue, the generator is triggered from it. Failed
  or timed-out runs reappear after the visibility timeout, with a bounded
  retry count and a dead-letter queue that raises an alarm. Bursts of edits
  coalesce into one full re-crawl. Rejected: async invocation with built-in
  retries (little control over retry timing, no coalescing); a workflow
  service (heavier than a blog this size needs).
- Still open: tracking of owned keys for deletion, CloudFront cache keys and
  invalidation scope, cutover from Phase 2, cost comparison, OpenTofu layout.
