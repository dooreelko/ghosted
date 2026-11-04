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


- Invalidation scope: one wildcard over the blog path at the end of each
  generator run. Why: independent of what changed, so an interrupted and
  retried run still ends fully invalidated. Accepted: images and feeds also
  leave the cache and refill from storage (negligible for a small blog);
  revisit only if it becomes a problem. Rejected: invalidating only changed
  paths (a run that dies between write and invalidate leaves stale pages on
  retry unless "written but not invalidated" state is kept); short cache
  lifetime with no invalidation (stale after every change).
- Still open: cache keys (cookies, HTML cache lifetime), tracking of owned
  keys for deletion, cutover from Phase 2, cost comparison, OpenTofu layout.


- HTML cache lifetime is long (about a day); freshness comes from the
  per-run invalidation. Rejected: a short lifetime as a backstop (more origin
  traffic, and the retried run already repeats the invalidation).


**Decision: cache behavior follows the origin's own Cache-Control, no TTL
overrides at the CDN.**
- Checked live as an anonymous visitor: only comment counts are marked
  public and are not member-specific; comment browse, the member call and
  the site info call are private and uncacheable, and browse carries
  per-member state.
- So: the counts route is cached without cookies (keyed by path and its ids
  parameter), with its lifetime set through Ghost's own config; everything
  else under the members API forwards the session cookie and is not cached.
  Static pages and assets and the Content API are cached without cookies;
  admin, link redirect and preview are not cached.
- Rejected: caching comment browse with the session cookie in the cache key
  (needs an override against Ghost's private header, for almost no traffic).
- Still open: tracking of owned keys for deletion, cutover from Phase 2,
  cost comparison, OpenTofu layout.


**Decisions: cutover from Phase 2**
- Copy-based cutover on two new buckets (content, store). Images copied once
  to their final keys; the database copied into the new store. The old setup
  keeps serving until the distribution flip, so there is no downtime window.
  Accepted: writes to the old setup after the copy are not carried over
  (single author, no signups, nothing scheduled). Hence no final re-sync and
  no schedule reconciliation.
- Secrets and the signing keys live in the database and the shared secret
  store, so member sessions, magic links and old newsletter links survive.
- Order: deploy with background schedules off, run the generator to
  completion, validate (URL parity crawl against the live site, old tracked
  and unsubscribe links, carried-over member session, admin draft roundtrip,
  alarms and caps in place), flip the distribution, invalidate, enable
  schedules, validate again. Good: remove the container service. Bad: restore
  the distribution; if the container is already gone, redeploy it from the
  infrastructure code against the pre-flip data. No soak period with the
  container running.
- Infrastructure code for Phase 3 is a copy of Phase 2's and becomes the
  source of truth; the distribution is imported into its state through the
  empty-plan gate. Phase 2 stays as a demo, unused.
- Rejected: staged cutover on a shared live store (double-fire risk for jobs
  and email, for no gain with a single author); stop-the-world restore with a
  downtime window (unnecessary without a store format change).
- Still open: redirects and custom routes on the live blog and the 404 page,
  whether the distribution leaves Phase 2's state, cost comparison, OpenTofu
  layout details.


- The live blog has no Ghost redirects or custom routes, so no redirect
  mechanism is needed at the edge; only the 404 page and directory indexes.
- After the distribution is imported into Phase 3's state, Phase 2's local
  backend configuration and cached state are deleted so Phase 2 can no longer
  be applied. Rollback after the container is removed runs from the Phase 3
  code (which keeps the container flag). The old data bucket and the container
  image repository are kept until the owner says otherwise.
- Still open: 404 page and directory-index handling at the edge, cost
  comparison, OpenTofu layout details.


- Cost: expected about $0.5-1.5 a month against about $12-13 for Phase 2,
  computed from measured traffic (a few thousand dynamic requests a month,
  far inside every free allowance). The zero-cost goal holds with large
  headroom. Earlier not pursued, reversed below: answering the anonymous
  member-session check at the edge (negligible cost, but see the latency
  decision).
- Still open: 404 page and directory-index handling at the edge, OpenTofu
  layout details.


- Infrastructure code follows Phase 2's logic: OpenTofu, versioned remote
  state, one file per component, staged flags defaulting off (storage first,
  functions and API next, distribution change last), the distribution adopted
  behind an empty-plan gate, instance values and resource identifiers kept out
  of tracked files, same scripts layout (deploy, verify, rollback). Differences
  are packaging only: per-function zip bundles instead of a container image.


**Decisions: edge handling of indexes and 404**
- Directory indexes: an edge function maps directory paths to their index
  object and redirects slash-less paths to the slash form, as Ghost does; the
  generator sets content types per object; static pages are cached without
  query strings or cookies.
- 404 page: the standard distribution-level custom error response, mapping
  404 to a generator-rendered theme page and keeping status 404. Accepted
  side effect: API 404s (JSON in Ghost) also receive the HTML page, because
  error responses are per distribution, not per behavior. Mitigation: admin
  and widget behavior on missing resources is a validation step before the
  flip. Rejected: failover to a not-found function (extra route and function
  for the same result); leaving the raw storage error.
- Still open: OpenTofu layout details only.


- Infrastructure state: Phase 3 starts from a full copy of Phase 2's code and
  a copy of Phase 2's state, so the first plan is empty; Phase 3 resources are
  added behind flags that default off, and cutover and rollback are the
  existing container flag turned off and on. Rejected: a skeleton with only new
  resources plus importing the distribution and the rest piecemeal (more
  surgery, and it would plan to recreate everything that already exists).


- Infrastructure split: the code owns configuration (functions, roles, API,
  queue, schedules, alarms) and each function's code is deployed separately by
  a script, so infrastructure applies never revert deployed code. Recurring
  background schedules stay disabled until cutover. The distribution change is
  the last stage.


- API routes: two variants per path family (bare, wildcard). The trailing-slash
  variant was dropped at the first deploy because API Gateway rejects route
  keys ending in a slash; slash requests match the wildcard route and reach
  the right function.



- Packaging of the Ghost-backed functions: one shared dependency tree, pruned
  to what the functions actually load (traced, not hand-picked), shipped as a
  single zip that every Ghost-backed function points at, each with its own
  entry file, memory size, timeout and route set. Plain handlers (link
  redirect, checkpoint) stay separate small zips. This refines "purpose-built
  bundle per function": trimming per function buys almost nothing because the
  shared core already is most of what any Ghost-backed function loads; what
  differs per function is the entry file and the sizing.
  Rejected: a JavaScript bundle (smaller on disk but boots ~45% slower and
  holds 40-85% more memory, fragile patches per Ghost upgrade); hand-pruning
  packages; a container image (not needed once pruned; the zip limit is met
  with a wide margin). Layers are optional later, for deploy speed only.
  Binaries are built for the function architecture (arm64 chosen; x86_64 is a
  one-line fallback if a native module fights back).
- Sizing: sized from measured memory, not trimmed to the floor. Plain
  handlers are smallest, Ghost-backed functions start at 512-1024 MB (CPU
  scales with memory, so a CPU-bound boot costs about the same at any size
  and starts faster larger), and the final sizes come from a sweep on real
  Lambda. At measured traffic Lambda stays inside the free tier either way.
- Delivery split: the primary goal is the read path (static site, generator,
  members and comments functions, redirect, image variants, content API,
  preview) including logged-in reader sessions; the admin functions and the
  email, scheduled-publish and maintenance functions are the secondary goal
  and follow once reads work. Reader sign-in sends the magic-link email, so
  the members function has read access to the SMTP credential.


- Edge answer for anonymous member checks: a CloudFront Function answers the
  member and session reads with an empty 204 when the request carries no
  members session cookie; requests with the cookie go to the members function.
  Why: a members function cold start costs about 5.6 s at 1 GB against 4 ms
  warm, and at this traffic nearly every call is cold, so visitors' portals
  wait on a boot to learn they are anonymous; money was never the issue
  (earlier rejected as negligible, reversed on latency). Accepted: the edge
  copies one small piece of Ghost's behavior, so it joins the post-cutover
  validation list. Rejected: a scheduled keep-warm ping (contradicts running
  only on demand), accepting the delay.


- Background work inside a request (webmention verification, and later the
  same shape for scheduled publish and newsletter sends): the function builds
  Ghost's jobs service itself, registers only the handler it needs, tracks the
  running job and waits for it before the function returns, because a Lambda
  is frozen after its response. Rejected: leaving the job to run after the
  response (never completes), a queue for webmentions (extra moving part for
  a feature with no known use).
- Functions whose role cannot write the store keep Ghost's incidental writes
  local to the invocation instead of trying to ship them. Why: a render run
  must not be able to change the store, and the failed ships were noise.
- Recurring schedules (checkpoint every 6 hours, maintenance daily) are on
  from the function stage, not held back until cutover. Why: they only touch
  Phase 3's own store, so they cannot clash with Phase 2's in-process jobs;
  without them store compaction depends on writes alone. Reversed an earlier
  hold-until-cutover setting.



- Admin uploads (images, media, theme zip) go through the admin function and
  Ghost's own upload routes, written to the content bucket by its storage
  adapter. Accepted: a request over the Lambda payload cap (about 4.5 MB of
  file after encoding) fails; photos for a single-author blog mostly fit.
  Rejected for now: presigned direct-to-S3 uploads (needs a patch to the
  built Ghost admin client that would have to be redone at every upgrade);
  revisit only if a real upload hits the cap.
- A successful admin write that can change the public site sends one request
  to the generate queue; the generator coalesces bursts.


- The built admin client is static, so the edge serves it from the content
  bucket like any other file (published by a script from the Ghost image);
  no admin hosting service. Staff sign-in works on Phase 3 once the sign-in
  mail path (new-device code to the staff user only) exists on the
  authentication function.
- Admin cold boot is slow (several seconds, longer when copies boot together)
  and that is accepted; the requirement is that work after it (writing a
  post) is fast. Rejected for now: provisioned concurrency, and skipping
  boot-time writes.
- A test-only admin URL override exists so staff can sign in on the test
  distribution; it must be cleared before the cutover. Newsletter sending is
  tested as part of publishing the blog post about this work, not before.


- Durable writes: a mutating admin or member request is not answered until
  its write is in the shared store. The store ships a write with a
  compare-and-swap; a write that loses to another copy's ship used to be
  dropped after the response had gone out (the user saw success, the change
  vanished). Now the handler waits for the ship and, on a lost race, discards
  the local state and replays the request against the fresh store with
  jittered backoff, bounded attempts, then a 503 so the client sees the
  failure. Messages to functions that read the store (the generate request)
  are sent only after the write is durable. Why: found by the smoke gate;
  cold boots of several admin copies at once make the race likely, and every
  write path (post save, sessions) was exposed. Accepted: one store commit of
  extra latency per write; side effects of a lost attempt can run twice (the
  generate request is idempotent; a one-shot schedule created twice is to be
  checked). Rejected: a save queue or an isolated post-save function (the
  admin client waits for the saved post, and other functions still write the
  same store), provisioned concurrency or tighter caps (narrow the window,
  do not close it). Still open: boot-time writes still race and log noise;
  the gate treats init-phase failures as warnings once that is decided.


- Boot does not write the store (reverses "rejected for now: skipping
  boot-time writes"). Ghost's own readiness step rebuilds the migrations
  table and takes the migration lock on every boot, so every cold copy shipped
  a no-op write and the copies raced each other. A function now only checks,
  read-only, that the store is migrated and refuses to start if not (a clear
  error, not a half-working site). Migrations run only when asked for: the
  maintenance function boots on an unmigrated store and migrates on an
  explicit request. Consequence for the cutover protocol and every Ghost
  upgrade: deploy, run the migration request once, then traffic. A brand-new
  store still writes its first-boot defaults once.
- A lost compare-and-swap is never merged, even when the other writer's pages
  are disjoint. Why: the merged commit rests on a local file that lacks the
  other writer's data, so what the request read may be stale and a later page
  write can overwrite the other writer's page; a durable-write test lost one
  acknowledged save in about one run in five before this. The request replay
  (any writing request, including a GET that records something) is the only
  recovery. Rejected: keeping the page-level merge for throughput (this is a
  single-author blog; correctness over write rate).


- Reader concurrency caps are a cost and blast-radius guard, not measured
  limits. The newsletter click redirect is never cached (the click is the
  write) and a send makes subscribers click together, so its cap was raised
  to 10; the others stay until real traffic says otherwise.


- Newsletter sending, found by practising with a one-person segment (a label
  on a test member, publish as email only to that segment): Ghost's bulk send
  goes through Mailgun, configured by the settings that came with the
  database, not through the SMTP credential (which only carries sign-in and
  magic-link mail). The send function must be asked to run only after the
  publish request's write is durable, and must never trust its own warm
  snapshot, because it reads the email row written moments earlier by another
  function; both were wrong and made sends hang until the function timed out
  (a timed-out send stays "submitting" and Ghost only retries "failed"). The
  practice is the rehearsal for the real send with the blog post; the real
  send to all members stays the owner's explicit go.


- The edge's anonymous-member shortcut (empty 204 for a member read without
  the session cookie) must not swallow requests that identify a member by a
  uuid in the query: the unsubscribe and newsletter-preference links in an
  email carry uuid and key and no cookie, so the shortcut left the
  unsubscribe page without data. Found by clicking the links of a practice
  send. Those requests now go to the members function; a smoke test covers
  it. Also learned: links in a mail point at the site URL, so before the
  flip they resolve against Phase 2; test them with the host swapped to the
  test distribution.



- Cutover executed. Order that worked: re-seed the Phase 3 store from live
  Phase 2 right before the flip (this wipes everything created in Phase 3
  while testing, including the test label and posts; decided, because the
  rehearsal data must not reach production); migrate explicitly through the
  maintenance function; run the generator to completion; compare what it
  wrote with the live site (all public pages and feeds identical; the only
  differences were the admin client files, which the live container serves as
  an older build); smoke suite and gate on the test distribution; clear the
  test-only admin URL; apply the distribution change; wildcard invalidation;
  smoke suite and gate again through the live domain. Phase 2's container and
  the test distribution stay until the owner says to remove them (rollback
  stays possible). Learned: the seed tool's offline migration used an older
  Ghost release than the functions run, so the function-side migration did the
  real work; the seed should use the functions' release. The one lost-race
  error during that migration left the store consistent (checked).
- Sign-in state must be visible across copies at once. A warm copy trusts its
  snapshot for a short time, so a session written by one copy was invisible to
  the next request on another and the admin bounced to the sign-in page right
  after a successful sign-in (it worked a moment later). The admin functions
  and the members function now check the store on every request (one small
  read each); the readers keep the short trust window. Found by the owner
  signing in, not by the tests.
- Concurrency caps must cover the parallel requests a browser makes. A page
  load sends several content API requests at once; the cap of 2 throttled one
  of them (the tiers answer), the sign-in script then failed to start and the
  sign-in link did nothing. Raised to 6. Lesson recorded as a rule for the
  smoke suite: it must send what a browser sends, in parallel and with several
  visitors, because sequential checks cannot see a cap; a test now does. The
  members and comments caps (5 and 3) have not shown the problem and are
  unchanged.
- The smoke test for the bare root accepts the live marketing page (the root
  is served from its own origin there) and still rejects a bucket listing.
- Known differences from Phase 2, accepted: a signed-in member's header still
  shows "Sign in" because pages are pre-rendered without a member (tracked as
  its own known-issue task). The sign-in 2FA mail arrived twice once; no
  replayed write was found, a cold start is the suspect, not confirmed.
- Open after the flip: owner's call on removing the container service and the
  test distribution; the real newsletter send to all members (owner's explicit
  go only); the stuck-at-submitting guard for the email function timeout; the
  comment-moderation frame; the keyed content API smoke test (needs a key).
  The account budget exists and the owner judged it sufficient.

- Live mail check after the flip: Ghost's built-in test email (sends only to the
  address given, no member send) reached the test member through Mailgun and all
  links in it worked on the live host. Not yet exercised on the live site: the
  real send path (the send function with tracked links to a one-person
  segment). Known gap: creating a post from HTML through the admin API fails
  because the HTML-to-editor-format converter is not in the function bundle;
  the admin editor does not use that route, so it only affects tooling.

- Phase 2 runtime removed after the flip, on the owner's explicit go: the
  container service, its runtime role and its image-pull grant are gone; the
  old data bucket and the image repository are kept (decided earlier). The
  distribution lost the container origin and the Phase 2 image-fallback group;
  its plan-time guard that tied the site distribution to the container service
  now also accepts the Phase 3 edge. Rollback from here means re-applying from
  the Phase 3 code with the container flag on, not a switch. The suite and the
  gate passed on the live domain afterwards. Learned: removing an origin that a
  failover group still names is rejected, so the group goes first, and a partly
  applied plan is safe to continue by planning again.
- The rehearsal (test) distribution was removed on the owner's go. From now on
  every check, including mail links, goes through the live domain.

- Remaining Phase 2 parts were removed on the owner's go: the container's
  three CloudWatch alarms (the one stuck in alarm since September included),
  the site distribution's origin for the Phase 2 data bucket with its access
  control and bucket read grant, and all but the newest image (with its two
  platform manifests) in the Phase 2 image repository. Kept: the alarm topic
  and its subscription (the Phase 3 alarms use it), and the Phase 2 data bucket
  itself, the only copy of the original production store, until the owner says.
  Learned: when an origin and the access control it uses are removed in the
  same plan, the control's delete runs first and is rejected as still in use,
  and the distribution update never starts. Drop the origin in one apply, the
  control in the next. The credentialed smoke run after this change was not
  done by the agent (reading the admin key was blocked); the owner runs it.
