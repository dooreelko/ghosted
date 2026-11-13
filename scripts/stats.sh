#!/usr/bin/env bash
# Visit statistics from the daily reports the visit-stats function writes
# (stats/visits/YYYY-MM-DD.json in the Phase 3 store bucket: [{path, views}, ...]).
#
# Usage: scripts/stats.sh [--day [YYYY-MM-DD] | --month [YYYY-MM] | --year [YYYY] | --all] [--histogram]
#   (no args)  the previous UTC day
#   --day      one day (default: the previous UTC day)
#   --month    one month, views summed per path (default: the current month so far)
#   --year     one year, views summed per path (default: the current year so far)
#   --all      every report, views summed per path
#   --histogram  with --month, --year or --all: instead of the per-path table, the total
#              views per day, one line each (day, count, a bar scaled to at most 100 chars)
#
# Only public HTML pages and the /book redirects are of interest: the job already
# drops assets, crawlers and the admin/members API, and this script also leaves out
# the RSS feed and the .md copies of posts.
#
# Needs duckdb and AWS credentials for the profile (AWS_PROFILE, default "default").
# The bucket is found by name prefix; set STATS_BUCKET to name it explicitly.
set -euo pipefail

usage() { sed -n '2,/^set -/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2; exit 2; }

mode=--day arg="" histogram=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --histogram) histogram=1 ;;
    --day|--month|--year|--all) mode="$1"; if [ "$#" -gt 1 ] && [[ "$2" != --* ]]; then arg="$2"; shift; fi ;;
    *) usage ;;
  esac
  shift
done

case "$mode" in
  --day)   day="${arg:-$(date -u -d yesterday +%F)}"; [[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || usage; pattern="$day"
           [ "$histogram" -eq 0 ] || { echo "stats.sh: --histogram needs --month, --year or --all" >&2; exit 2; } ;;
  --month) month="${arg:-$(date -u +%Y-%m)}";       [[ "$month" =~ ^[0-9]{4}-[0-9]{2}$ ]] || usage; pattern="$month-*" ;;
  --year)  year="${arg:-$(date -u +%Y)}";           [[ "$year" =~ ^[0-9]{4}$ ]] || usage; pattern="$year-*" ;;
  --all)   [ -z "$arg" ] || usage; pattern='*' ;;
esac

bucket="${STATS_BUCKET:-$(aws s3api list-buckets --query "Buckets[?starts_with(Name,'ghost-phase3-store-')].Name | [0]" --output text)}"
[ -n "$bucket" ] && [ "$bucket" != None ] || { echo "stats.sh: no ghost-phase3-store-* bucket found; set STATS_BUCKET" >&2; exit 1; }

# -init /dev/null: ignore ~/.duckdbrc, so the setup below is all there is; the setup's
# own result tables ("Success") are sent to /dev/null.
read_reports="read_json('s3://${bucket}/stats/visits/${pattern}.json', columns = {path: 'VARCHAR', views: 'BIGINT'}, filename = true)"
keep="path NOT LIKE '%.md' AND path NOT LIKE '%/rss/'"

if [ "$histogram" -eq 1 ]; then
  # One plain-text line per day: the bar is proportional to the busiest day (100 chars).
  query="
WITH d AS (
  SELECT regexp_extract(filename, '(\\d{4}-\\d{2}-\\d{2})\\.json\$', 1) AS day, sum(views)::BIGINT AS views
  FROM ${read_reports} WHERE ${keep} GROUP BY day
)
SELECT day || '  ' || lpad(views::VARCHAR, length((SELECT max(views) FROM d)::VARCHAR)::INTEGER, ' ') || '  ' || repeat('█', greatest(1, round(views * 100.0 / (SELECT max(views) FROM d))::INTEGER))
FROM d ORDER BY day;"
  format=(-cmd ".mode list" -cmd ".headers off")
else
  query="
SELECT path, sum(views)::BIGINT AS views
FROM ${read_reports} WHERE ${keep}
GROUP BY path
ORDER BY views DESC, path;"
  format=()
fi

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
);" -cmd ".output stdout" -cmd ".maxrows 100000" "${format[@]}" -c "$query"
