Live: the alarm is in ALARM from a single stale datapoint (9.0 at
2026-09-10 14:00), while the very next boot (17:50 that day) published 0.0.
Because period=604800 (1 week) with statistic=Maximum and
evaluation_periods=1, one transient nonzero reading pins the alarm in ALARM
until it ages out of the rolling week -- every later clean boot is
invisible. With ok_actions also wired, the operator gets a spurious
"recovered" email up to a week later, decoupled from anything that
happened at that time. All three checkpoint alarms (orphaned-segments,
restore-retries, restore-duration) share this shape.

Two further design notes:
- A nonzero reading may be expected, not a regression: reclaimSuperseded
  skips any candidate protected by an active lease and never retries it --
  those segments become permanent orphans by design, only cleaned up
  manually via deorphan.sh. So OrphanedSegmentCount > 0 conflates "the
  checkpoint fix regressed" with "a checkpoint happened to overlap a boot"
  (benign, self-inflicted, especially during active redeploy churn).
- The metric under-reports by construction: minAgeMs defaults to 1 hour and
  the boot sweep runs seconds after container start, so a leak created in
  the hour before a restart is invisible to that boot's reading.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: discuss with the human whether this is acceptable as-is
(manual-clear-after-fix is a normal ops pattern, already discussed once
this session) or worth a period/threshold redesign; consider raising the
threshold above 0 or documenting the "run deorphan.sh, don't wait" runbook
step explicitly.
