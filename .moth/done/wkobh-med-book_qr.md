we need a qr code that 
- points to an address under https://the-well-architected-cloud.com/book 
- which is an immediate redirect to https://leanpub.com/well-architected-cloud so that we get click tracking from cloudwatch
- uses ../wac/web/android-chrome-512x512.png as a center-image (python-qrcode seems to support that)

----- AI agent updates -------

## Decision record (2026-11-12)

**Redirect at the edge: a CloudFront Function answering `/book*` with a 302 to the
Leanpub page, attached via an ordered behavior in the phase3 IaC.** No origin, no
Lambda. CloudFront standard logs (see klcfz) already record edge-answered
requests, so click tracking needs no new infrastructure.
Rejected: Lambda redirect (cold starts and cost for a static answer), S3 website
redirect (distribution uses the REST origin).

**QR points to `/book/qr`.** `/book/<anything>` redirects, so each placement
(newsletter, talk, ...) can get its own path and its own count.
Rejected: bare `/book` (no per-placement attribution).

**302, not 301.** Not cached by browsers, so every scan is counted and the target
can change later.

**Saved Logs Insights query "book clicks"** counting `/book*` per path per day.
The existing top-pages query keeps successful GETs only, so it would miss 302s.
Crawlers excluded by user agent, as there.

**QR generator: a script using python-qrcode run via system `uv`**, error
correction H (needed for the center image), logo ~25% of width. Takes URL, logo
path and output path as args. The generated PNG is **tracked** in the repo.
Rejected: untracked/on-demand output.

## Out of scope
- Dashboards/alarms on book clicks.
- Other redirect targets or placements beyond `/book/qr`.


## Decision record 2 (2026-11-12): daily visit statistics

Scope extended into this issue: a scheduled job that, once a day, produces visit
statistics for the previous day, covering the home page, blog pages and the
`/book/qr` clicks. Runs as one more recurring job next to the existing ones.

**Output: one JSON file per day in S3.** Full per-page detail, kept as long as we
choose rather than the 90-day log retention.
Rejected: CloudWatch custom metrics (per-page detail limited by dimensions), email
digest (no history), log line only (same retention problem as the access logs).

**Blog detail: per-page counts, top N**, with the home page and `/book/qr` as
named lines. Rejected: aggregates only (no per-post view).

**Counting rules follow the existing top-pages query** (successful GETs of
non-asset paths, crawlers excluded); book clicks follow book-clicks (302s).

## Decision record 3 (2026-11-12): outcome and refinements

**Shipped and applied.** The redirect, the book-clicks query and the daily stats
job are live. Verified: `/book`, `/book/` and `/book/qr` answer 302 to the Leanpub
page at the edge (logged as function-generated responses); `/bookshelf` is not
caught. The QR exists in two tracked variants, square and rounded modules, both
encoding the `/book/qr` address; both decode with a QR reader (not yet scanned
with a phone).

**Both "home pages" are reported:** the marketing root `/` and the blog root
`/blog/`, as separate lines. Rejected: treating only one as "home".

**Stats job placement and timing.** A dedicated function, not folded into
maintenance (different permissions: read the access logs, write only under a
`stats/` prefix of the Phase 3 store bucket, which the store's own sweeps never
touch). Runs daily shortly after midnight UTC for the previous UTC day; a day can
be re-run by name. Reports are overwritten on re-run, so they are idempotent.
Backfilled for every day the logs hold (from the day logging began).
Rejected: a public location (the content bucket is served at `/blog/*`).

**Report content:** root, blog root, blog total, top 50 blog pages, `/book/qr`
clicks, other `/book/*` paths.

## Known gaps / open
- Counting rules are the top-pages rules, which still count the RSS feed and
  the `.md` copies of posts as pages; they inflate blog totals (the feed is the
  top "page" on some days). Decision pending whether to exclude them; if so,
  change both the saved query and the job, then re-run the backfill.
- Whether the access log records the viewer's original path or the rewritten
  one for the root and blog root was inferred, not confirmed; real data shows
  non-zero values for both.
- Any distribution change re-plans every function's IAM policy as "known after
  apply" (it references the distribution); the apply resolves them to no change.


## Closed (2026-11-13)
Closed by the human with the feed/`.md` counting question left as a known gap
(see above); it can become its own issue. The phase 3 architecture diagram shows
the daily stats job and the access-log group it reads. The diagram's layout step
is very slow (tens of minutes of compute) with the current tool; render it in the
background.
