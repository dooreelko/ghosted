After the first real newsletter send the click-tracking redirect function was throttled at its reserved concurrency of 10 (mail clients and link scanners fetch every tracked link at once) and returned 503 for some links, which also fired the API server-error alarm. The alarm fires on any single 5xx in five minutes and flaps on isolated admin cold-start timeouts.

Decided: raise the redirect function's reserved concurrency to 30 (cost only on invocation, total reserved stays far below the account limit); make the API server-error alarm tolerate isolated errors (more than four in five minutes) so it signals a real incident.

Out of scope: making the send wait for the site regeneration; admin cold-start tuning.


----- AI agent updates -------

- Done and live: the redirect function's reserved concurrency is 30 (was 10);
  the API server-error alarm now fires on more than four errors in five
  minutes (was any). Applied with a plan reviewed first; two in-place changes,
  nothing else. The alarm re-evaluates on the new threshold; it showed in
  alarm for a few minutes from an evaluation made with the old threshold.
- Related, same cause family: the image fallback function was raised from 2
  to 10 earlier today for the same send-time burst (see nx54g).
