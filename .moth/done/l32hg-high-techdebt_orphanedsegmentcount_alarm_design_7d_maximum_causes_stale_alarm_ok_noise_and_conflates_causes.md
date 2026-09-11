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

Decision (2026-09-11, discussed with human): fixed only orphaned-segments,
left restore-retries/restore-duration as-is (they're live-signal alarms,
not sticky-regression alarms -- this design problem doesn't apply to them).

Accepted: sticky-on-last-boot alarm shape. period 604800 -> 60 (CloudWatch
minimum) and treat_missing_data notBreaching -> ignore. A bad boot sets
ALARM and it holds regardless of how many quiet weeks follow (no more
auto-expiry); the next boot reporting 0 clears it immediately and the OK
notification is now caused by that real event instead of a stale window
aging out.

Rejected: raising the threshold above 0 to tolerate benign lease-collision
orphans. Kept threshold=0 -- ALARM is still expected to conflate "real
leak" with "benign lease collision during redeploy churn"; addressed via a
runbook note instead (phase2/readme.md's Monitoring bullet) telling the
operator to run deorphan.sh and check the next boot before assuming a
regression, rather than by changing what triggers the alarm.

Backup plan (not applied, kept for reference if the sticky design proves
noisy in practice): period=1d, evaluation_periods=7, statistic=Maximum --
same weekly-boot tolerance as the original but self-clears within a day of
the last bad datapoint instead of a week.

Out of scope: the metric's under-reporting (minAgeMs=1h vs. sweep running
seconds after boot) -- not addressed by this fix, still a real gap if a
leak forms in the hour before a restart.

Implementation: phase2/iac/monitoring.tf (orphaned_segments alarm),
phase2/readme.md (Monitoring bullet runbook note).
