## Problem

The latest newsletter (sent 2026-11-05, 32 recipients) reports zero opens in Ghost
analytics. Open tracking is Mailgun's own pixel, so CloudFront never sees it. Ghost
learns about opens (and deliveries, failures, spam complaints) by polling the Mailgun
events API from a recurring in-process job. Phase 3 has no process to run that job:
the Ghost scheduler registers it with the jobs service, but nothing in the Lambda
setup persists or fires it. Only `maintenance` (daily) and `sqlite-checkpoint`
(6-hourly) are scheduled in IaC. So Mailgun events are never ingested.

Likely also affected (unverified): delivery/bounce state, recipient failures, spam
complaints and suppression list updates, since the same poll feeds them.

## Decision (2026-11-06)

**Poll Mailgun on an EventBridge recurring schedule, every 6 hours, always on** (not
gated on a recent send), following the existing `maintenance` pattern.

Why: reuses the proven scheduled-Lambda path, no new moving parts. Every 6 hours keeps
the cost of the SQLite restore cold start low; open stats lagging by hours is fine for
a small newsletter.

## Scope

- Newsletter analytics (opens, deliveries, failures, complaints).
- Verify the first run backfills the 2026-11-05 send; Mailgun only keeps events for a
  limited time, so check soon.

## Open questions

- Automation (welcome) emails have their own analytics job in Ghost (separate Mailgun
  tag and table). Include now or defer?
- Separately: do welcome emails get sent at all on phase 3? Ghost sends them from an
  automations poll (immediate on signup, timer/scheduler for delayed steps); not
  verified that this works under Lambda.

## Out of scope

- Gift delivery analytics (gift subscriptions are not used).
- Cold-start 5xx on link redirect and other paths (separate issue).




----- AI agent updates -------

## Decision record 2 (2026-11-06)

**Placement: a new dedicated function** (own timeout, memory, log group), invoked by
an EventBridge recurring schedule every 6 hours, always on. Matches the existing
one-function-per-job layout. Rejected: folding into `maintenance` (daily cadence, short
timeout, a slow Mailgun fetch could starve the token cleanups) and into
`sqlite-checkpoint` (a slow external API call must not share a function with the
store's compaction writer or its alarms).

**Scope: newsletter analytics only; automation (welcome) analytics deferred.** Welcome
emails may not be sent at all on phase 3 (moth eiavu), so there is nothing to poll yet.
Revisit after that is resolved. Gift analytics stays out (feature unused).

**Mechanism:** the function boots Ghost, runs the newsletter analytics fetch once per
invocation (the same fetch Ghost's in-process job runs), then exits. Mailgun
credentials come from Ghost's settings in the store, as for the send path. The fetch
resumes from per-table cursors held in the store, so a skipped or failed run is caught
up by the next one, which also covers backfilling the 2026-11-05 send as long as
Mailgun still retains its events.


## Outcome (2026-11-06)

Deployed through the full OpenTofu deploy (moth d4hkj). The first run ingested the
2026-11-05 send's Mailgun events: 32 deliveries and 22 opens, so the backfill worked
and Mailgun still held the events. The schedule fired on creation and runs every 6
hours from there. Automation (welcome) analytics remains deferred (moth eiavu).
