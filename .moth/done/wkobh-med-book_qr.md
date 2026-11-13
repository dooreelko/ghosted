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


## Decision record 4 (2026-11-13): reopened, daily report is a plain array

Reopened to simplify the daily report format.

**The report is just an array of path/views**, one entry per counted path, for the
whole day; no named fields (root, blog root, qr, totals), no top-N cut. Page
views and book clicks share the one array (their paths never overlap: book paths
are 302s, pages are 2xx/304). The date lives in the file name only. Any grouping
(home pages, blog total, per-placement book clicks, excluding the feed) is
analytics done later at query time, not by the job.
Why: the named fields were analytics baked into the job; they lost the long tail
and made the shape depend on today's questions. Supersedes the "report content"
and "top N blog pages" decisions above.

**The noise filters stay** (assets, Ghost admin/members API, self-declared
crawlers, same as top-pages): junk nobody wants, and keeping it keeps the files
small. Rejected: fully raw output (much bigger, mostly junk). Open until the
human confirms.

**Existing reports are regenerated** in the new format for every day the logs
hold (same file names, overwritten).

This resolves the "feed and `.md` counted as pages" gap for the reports: those
paths are now rows that analysis can exclude. The saved top-pages query is
unchanged.


**Outcome (2026-11-13).** Applied. Every report from the first day the logs hold
through the current day was regenerated in the array format (the previous format
is gone from the bucket); all files verified to be arrays. The job refuses to
write a report when the log query hits its row ceiling, so a truncated day cannot
be mistaken for a whole one.


## Decision record 5 (2026-11-13): reading the reports

**Filter confirmed by the human.** Only public HTML pages and the `/book` redirects
matter; assets, crawlers and the admin/members API are of no interest, so the job
keeps dropping them. (Closes the "open until confirmed" point in record 4.)

**A small script queries the reports with DuckDB**, run from a shell: the previous
day by default, or a named day, a month, a year, or everything; multi-day modes
sum views per path. Month and year default to the current one so far.
It also leaves out the RSS feed and the `.md` copies of posts at query time (the
reports keep them as rows; only the view hides them), which settles the
"feed and `.md` counted as pages" gap for anyone reading through the script.
The script is self-contained (does not depend on the user's DuckDB rc file) and
finds the store bucket by its name prefix, or from an environment variable, so no
bucket name sits in a tracked file.
Rejected: an Athena/Glue table (more infrastructure than a handful of small JSON
files warrants); computing the aggregates in the job (back to baked-in analytics).


**Optional histogram view of the same script** for the multi-day modes: one line
per day (day, total views, a bar scaled so the busiest day is 100 characters wide).
Same filters as the table; not offered for a single day (nothing to compare).
Days are listed top to bottom, so the chart scrolls vertically.


**Histogram width follows the terminal** (supersedes the fixed 100-character bar
above): the whole line takes 80% of the detected terminal width, the busiest day's
bar filling what the day and count leave. Falls back to 80 columns when the width
cannot be detected; an environment override exists for non-interactive use.


**Histogram width is a setting, not a constant** (supersedes the 80% above): the
share of the terminal the line takes defaults to 90%, and the width assumed when
the terminal cannot be detected defaults to 80 columns (so an undetected line
still fits a classic terminal). Both can be overridden from the environment.


## Status (2026-11-13): current state, superseding earlier notes

- **The issue is open again** (reopened by the human); the "Closed" note above
  describes the first close and no longer applies.
- **QR codes verified by the human with a phone**: both variants (square and
  rounded modules) scan correctly and land on the Leanpub page.
- **The "feed and `.md` counted as pages" gap is closed.** The reports now keep
  every counted path as its own row and the reading script hides those two kinds
  at query time; the saved top-pages query is unchanged and still counts them.
  The "report content" and "top N" decisions in record 3 are superseded by the
  plain array in record 4.
- **Per-placement paths:** each placement gets its own `/book/<name>` path and
  QR; the reports list every such path as an ordinary row, nothing needs
  registering. A mistyped path still redirects (and is counted under its own
  name) because the redirect does not validate paths.
- **Still open:** which QR variant is the one to use is not decided; the daily
  reports are kept indefinitely (no expiry rule), which is fine at their size
  but unstated until now; the access log's recorded path for the root and blog
  root was inferred (data looks right).


## Closed (2026-11-13, second close)
Closed by the human. Final state: the `/book` redirect and both QR variants, the
daily stats job writing plain path/views arrays, the DuckDB reading script with its
histogram view, all deployed and verified. Leftovers (QR variant choice, report
expiry) are the "Still open" items in the status section above and are not blocking.
