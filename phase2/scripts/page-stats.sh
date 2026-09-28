#!/usr/bin/env bash
# Per-page request histogram from the site's CloudFront access logs
# (moth klcfz). Runs the saved Logs Insights "top pages" query defined in
# iac/access-logs.tf -- that definition is the single source of truth for
# what counts as a page view -- and draws the result as a text histogram.
# Usage: page-stats.sh [days] [top-n]   (defaults: 7 days, top 50)
set -euo pipefail

REGION="us-east-1"
QUERY_NAME="ghost-site/top-pages"
LOG_GROUP="/aws/vendedlogs/cloudfront/ghost-site-access"
DAYS="${1:-7}"
TOP_N="${2:-50}"
BAR_WIDTH=50

for v in "$DAYS" "$TOP_N"; do
  if ! [[ "$v" =~ ^[1-9][0-9]*$ ]]; then
    echo "days and top-n must be positive integers, got: $v" >&2
    exit 1
  fi
done

QUERY="$(aws logs describe-query-definitions \
  --region "$REGION" \
  --query-definition-name-prefix "$QUERY_NAME" \
  --query "queryDefinitions[?name=='$QUERY_NAME'] | [0].queryString" \
  --output text)"
if [ -z "$QUERY" ] || [ "$QUERY" = "None" ]; then
  echo "saved query '$QUERY_NAME' not found -- has iac/access-logs.tf been applied?" >&2
  exit 1
fi
QUERY="$(echo "$QUERY" | sed -E "s/\| limit [0-9]+/| limit $TOP_N/")"

END="$(date +%s)"
START="$((END - DAYS * 86400))"

QUERY_ID="$(aws logs start-query \
  --region "$REGION" \
  --log-group-name "$LOG_GROUP" \
  --start-time "$START" \
  --end-time "$END" \
  --query-string "$QUERY" \
  --query queryId \
  --output text)"

while :; do
  RESULT="$(aws logs get-query-results --region "$REGION" --query-id "$QUERY_ID" --output json)"
  STATUS="$(echo "$RESULT" | jq -r .status)"
  case "$STATUS" in
    Complete) break ;;
    Scheduled | Running) sleep 1 ;;
    *)
      echo "query ended with status $STATUS" >&2
      exit 1
      ;;
  esac
done

ROWS="$(echo "$RESULT" | jq -r '.results[] | map({(.field): .value}) | add | "\(.requests)\t\(.path)"')"
if [ -z "$ROWS" ]; then
  echo "No page views in the last $DAYS day(s)."
  exit 0
fi

SCANNED="$(echo "$RESULT" | jq -r '.statistics.recordsScanned | floor')"
echo "Top $TOP_N pages, last $DAYS day(s) ($SCANNED log records scanned)"
echo
echo "$ROWS" | awk -F'\t' -v width="$BAR_WIDTH" '
  { count[NR] = $1; path[NR] = $2; total += $1
    if ($1 > max) max = $1
    if (length($2) > pw) pw = length($2) }
  END {
    if (pw > 60) pw = 60
    if (pw < 13) pw = 13
    for (i = 1; i <= NR; i++) {
      n = int(count[i] * width / max + 0.5); if (n < 1) n = 1
      bar = sprintf("%" n "s", ""); gsub(/ /, "#", bar)
      p = path[i]; if (length(p) > pw) p = substr(p, 1, pw - 3) "..."
      printf "%-" pw "s %7d  %s\n", p, count[i], bar
    }
    printf "\n%-" pw "s %7d\n", "total (shown)", total
  }'
