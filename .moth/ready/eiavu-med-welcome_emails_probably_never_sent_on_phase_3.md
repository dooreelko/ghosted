## Problem

Suspected: new-member welcome emails are not sent on phase 3. Not confirmed.

Ghost sends welcome emails as automation steps run by an automations poll. An
immediate step is triggered by an in-process domain event on signup; a delayed step
relies on an in-memory timer plus the scheduler adapter to wake the server. Under
Lambda the request can return before in-process work finishes, and the timer dies with
the instance. No Lambda function is wired to run the poll, and no recurring schedule
triggers it. The members-session function can send mail (SMTP) but has no queue or
invoke path to another function.

Evidence so far (2026-11-06, logs read-only):
- 3 magic-link signups on 2026-11-04 (about 10:12-10:25 UTC); no welcome or
  automation send log lines in any function over 30 days.
- Two automations exist in the DB (created by a 2026-11-04 migration); unknown
  whether either is active.
- The signups may have been existing members signing in, which would not trigger a
  welcome email, so this is not proof of a bug.

## Next step (decision pending)

Verify first: one real signup with a fresh address, then check the members-session
logs for automation poll activity and whether the mail arrives. It writes to prod and
sends a real email, so needs the owner's go-ahead and an address.

## Out of scope

- Welcome-email analytics (opens/deliveries) -- tracked in the Mailgun analytics issue
  (hnq5o).
- Gift delivery emails (not used).
