#!/usr/bin/env bash
# Visit statistics from the daily reports the visit-stats function writes
# (stats/visits/YYYY-MM-DD.json in the Phase 3 store bucket: [{path, views}, ...]).
#
# Usage: scripts/stats.sh [--day [YYYY-MM-DD] | --month [YYYY-MM] | --year [YYYY] | --all]
#   (no args)  the previous UTC day
#   --day      one day (default: the previous UTC day)
#   --month    one month, views summed per path (default: the current month so far)
#   --year     one year, views summed per path (default: the current year so far)
#   --all      every report, views summed per path
#
# Only public HTML pages and the /book redirects are of interest: the job already
# drops assets, crawlers and the admin/members API, and this script also leaves out
# the RSS feed and the .md copies of posts.
#
# Needs duckdb and AWS credentials for the profile (AWS_PROFILE, default "default").
# The bucket is found by name prefix; set STATS_BUCKET to name it explicitly.
set -euo pipefail

usage() { sed -n '2,/^set -/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2; exit 2; }

mode="${1:---day}"
[ "$#" -eq 0 ] && mode=--day
arg="${2:-}"
[ "$#" -le 2 ] || usage

case "$mode" in
  --day)   day="${arg:-$(date -u -d yesterday +%F)}"; [[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || usage; pattern="$day" ;;
  --month) month="${arg:-$(date -u +%Y-%m)}";       [[ "$month" =~ ^[0-9]{4}-[0-9]{2}$ ]] || usage; pattern="$month-*" ;;
  --year)  year="${arg:-$(date -u +%Y)}";           [[ "$year" =~ ^[0-9]{4}$ ]] || usage; pattern="$year-*" ;;
  --all)   [ -z "$arg" ] || usage; pattern='*' ;;
  *)       usage ;;
esac

bucket="${STATS_BUCKET:-$(aws s3api list-buckets --query "Buckets[?starts_with(Name,'ghost-phase3-store-')].Name | [0]" --output text)}"
[ -n "$bucket" ] && [ "$bucket" != None ] || { echo "stats.sh: no ghost-phase3-store-* bucket found; set STATS_BUCKET" >&2; exit 1; }

# -init /dev/null: ignore ~/.duckdbrc, so the setup below is all there is; the setup's
# own result tables ("Success") are sent to /dev/null.
duckdb -init /dev/null -cmd ".output /dev/null" -cmd "
INSTALL aws;
SET autoload_known_extensions = 1;
CREATE OR REPLACE SECRET secret (
    TYPE s3,
    PROVIDER credential_chain,
    CHAIN config,
    PROFILE '${AWS_PROFILE:-default}',
    REGION 'us-east-1'
);" -cmd ".output stdout" -cmd ".maxrows 100000" -c "
SELECT path, sum(views)::BIGINT AS views
FROM read_json('s3://${bucket}/stats/visits/${pattern}.json', columns = {path: 'VARCHAR', views: 'BIGINT'})
WHERE path NOT LIKE '%.md' AND path NOT LIKE '%/rss/'
GROUP BY path
ORDER BY views DESC, path;
"
