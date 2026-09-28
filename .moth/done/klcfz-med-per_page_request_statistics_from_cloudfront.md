## Problem

There are no per-page request stats for the site. The distribution has no access
logging (legacy S3 logs off, no standard-logs v2 delivery, no real-time logs, no
additional-metrics subscription). Default CloudWatch metrics are per-distribution
only. The console "Popular objects" report is top-50, console-only, no history.

## Decision (2026-09-28)

**First approach: CloudFront standard logs (v2) delivered to CloudWatch Logs,**
queried with Logs Insights for per-path request counts. Managed in phase2 IaC
alongside the distribution.

Why: simplest path to queryable per-page data with no extra moving parts (no
bucket/Glue/Athena setup), and Logs Insights is already the tool at hand for the
app's own logs.

**Cost is accepted for now; optimise later if it gets expensive.** CloudWatch Logs
ingestion is the main cost driver (per GB of log data). If it grows, the planned
fallback is switching the delivery destination to S3 + Athena (storage + per-query
cost only).

## Out of scope

- Real-time logs (Kinesis) -- overkill for a blog.
- S3 + Athena -- deferred, only if CloudWatch cost becomes a problem.
- Dashboards/alarms on per-page stats -- can follow once data exists.


----- AI agent updates -------

## Decision record 2 (2026-09-28): retention, field set, saved query

**Retention: 90 days.** Enough for quarter-over-quarter comparison with
bounded storage. Rejected: 30 days (too short for trends), 1 year / never
(storage cost for little extra value at this stage).

**Log record fields: a trimmed subset, not the ~33 defaults.** Kept: time,
method, path, status, edge cache result, bytes, time taken, referer, user
agent, edge location. Roughly halves ingestion size, which is the main cost
driver.
- **No client IP (nor forwarded-for).** Personal data (GDPR); the price is
  giving up unique-visitor counts. Rejected: subset-with-IP.
- **No query string.** Ghost member sign-in magic links carry a one-time
  token in the query string; logging it would keep live-ish credentials
  readable in logs for the retention period. Price: UTM/campaign
  parameters are lost. Rejected: keeping the query string.
- **No cookies.** Same reason (session cookies).
- Known residual: the Referer of same-origin requests could in principle
  carry a full URL with query; accepted as low risk.

**JSON output format**, so Logs Insights discovers fields without parsing.

**A saved Logs Insights "top pages" query ships with the IaC**, answering
the original question (top 50 pages) for any time range. It approximates
human page views rather than raw requests: successful GETs only, static
assets excluded, Ghost admin/members API excluded, self-declared crawlers
excluded by user agent. Raw request volume remains queryable ad hoc.

## Implementation abstract

- All new resources live on the CloudWatch Logs side (standard logging v2:
  a delivery source bound to the site distribution, a log-group delivery
  destination, and the delivery itself carrying the field list). The
  distribution resource itself is unchanged -- legacy logging stays off.
- The log group uses the vended-logs naming convention, and the log
  delivery service's write permission is granted by an explicit resource
  policy in IaC rather than the one CreateDelivery would create
  implicitly outside state.
- Delivery source must be in us-east-1 (CloudFront is global); matches the
  config's only region.
- Cost line added to phase2 readme (~$0.15 per 1M requests ingestion plus
  storage), with S3 + Athena noted as the fallback.


## Decision record 3 (2026-09-28): deployed; histogram script

**Deployed and delivering.** First records arrived within minutes of the
apply. Observed record shape: every field is delivered as a string
(status included), user agents are URL-encoded, and records run ~400
bytes -- cost estimate in the phase2 readme adjusted accordingly.

**Per-page histogram script (phase2 scripts).** Takes a look-back window
in days and a top-N, runs the saved "top pages" query, and prints a text
histogram (path, count, proportional bar, total). It fetches the saved
query definition by name rather than carrying its own copy, so the
definition of "a page view" lives in exactly one place (the IaC); the
script only overrides the result limit. Rejected: embedding the query in
the script (two copies to drift apart).
