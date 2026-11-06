Line: SUMMARY="$(aws s3 ls "s3://$BUCKET/segments/" --recursive --summarize | tail -2)".
aws s3 ls exits 1 on an empty/absent prefix; with `set -euo pipefail` the
assignment fails and the script dies before printing anything. This is
exactly the state upgrade.sh's recovery path can leave things in after a
partial failure -- re-running the recovery dies immediately at the moment
it's needed most.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: tolerate an empty/absent prefix (e.g. `|| true` on the ls,
or check existence first) so the script can report "already empty" instead
of crashing.
