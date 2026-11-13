import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Daily visit statistics for the previous UTC day, read from the CloudFront access logs with
// Logs Insights and written as one JSON file per day under stats/ in the store bucket: a plain
// array of { path, views }, page views and book clicks together (their paths never overlap).
// Grouping and totals are analysis, done later at query time. (The
// sqlite store's own sweeps only touch segments/, so the prefix is safe). The access logs
// expire after 90 days; these files are the long-term record.
//
// What counts follows the saved "top pages" query in access-logs.tf: successful GETs of
// non-asset paths, no Ghost admin/members API, no self-declared crawlers. Keep the two in step.

const MAX_ROWS = 10000; // the Logs Insights result ceiling

const PAGE_VIEWS_QUERY = `
  fields \`cs-uri-stem\` as path
  | filter \`cs-method\` = "GET"
  | filter \`sc-status\` like /^(2|304)/
  | filter path not like /\\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|xml|txt|json)$/
  | filter path not like /^\\/blog\\/(ghost|members\\/api)\\//
  | filter \`cs(User-Agent)\` not like /(?i)(bot|crawl|spider|slurp|preview|monitor)/
  | stats count(*) as views by path
  | sort views desc
  | limit ${MAX_ROWS}`;

// The book short link answers 302 at the edge; top pages does not see those.
const BOOK_CLICKS_QUERY = `
  fields \`cs-uri-stem\` as path
  | filter \`cs-method\` = "GET"
  | filter path like /^\\/book(\\/|$)/
  | filter \`sc-status\` = 302
  | filter \`cs(User-Agent)\` not like /(?i)(bot|crawl|spider|slurp|preview|monitor)/
  | stats count(*) as clicks by path
  | sort clicks desc
  | limit ${MAX_ROWS}`;

// The previous UTC day relative to `now`: { date: 'YYYY-MM-DD', start, end } in epoch seconds.
export function previousDay(now) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = end - 24 * 3600 * 1000;
  return { date: new Date(start).toISOString().slice(0, 10), start: start / 1000, end: end / 1000 };
}

// A named day (YYYY-MM-DD), for backfills.
export function dayOf(date) {
  const start = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(start)) throw new Error(`bad date: ${date}`);
  return { date, start: start / 1000, end: start / 1000 + 24 * 3600 };
}

// Logs Insights rows ([{field,value}, ...]) to { path: count }.
export function rowsToCounts(rows, countField) {
  const counts = new Map();
  for (const row of rows) {
    const cell = Object.fromEntries(row.map((c) => [c.field, c.value]));
    const n = Number(cell[countField]);
    if (cell.path && Number.isFinite(n)) counts.set(cell.path, (counts.get(cell.path) ?? 0) + n);
  }
  return counts;
}

// One { path, views } per path, most viewed first (ties by path, so a re-run is byte-identical).
export function buildReport(pageCounts, bookCounts) {
  const all = new Map(pageCounts);
  for (const [path, n] of bookCounts) all.set(path, (all.get(path) ?? 0) + n);
  return [...all]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([path, views]) => ({ path, views }));
}

async function runQuery(logs, { logGroup, query, day, pollMs, sleep }) {
  const { queryId } = await logs.send(new StartQueryCommand({ logGroupName: logGroup, queryString: query, startTime: day.start, endTime: day.end - 1, limit: MAX_ROWS }));
  for (;;) {
    const res = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (res.status === 'Complete') {
      const rows = res.results ?? [];
      // A full result may be cut off; a truncated report must not be written as if it were whole.
      if (rows.length >= MAX_ROWS) throw new Error(`Logs Insights returned ${MAX_ROWS} rows, the ceiling: result may be truncated`);
      return rows;
    }
    if (['Failed', 'Cancelled', 'Timeout'].includes(res.status)) throw new Error(`Logs Insights query ${res.status}`);
    await sleep(pollMs);
  }
}

export function createVisitStatsHandler(opts = {}) {
  const logGroup = opts.logGroup ?? process.env.ACCESS_LOG_GROUP;
  const bucket = opts.bucket ?? process.env.STORE_BUCKET;
  if (!logGroup || !bucket) throw new Error('ACCESS_LOG_GROUP and STORE_BUCKET are required');
  const logs = opts.logs ?? new CloudWatchLogsClient({});
  const s3 = opts.s3 ?? new S3Client({});
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 2000;

  // event.date (YYYY-MM-DD) re-runs a named day; a schedule sends none and gets yesterday.
  return async function handler(event) {
    const day = event?.date ? dayOf(event.date) : previousDay(now());
    const [pageRows, bookRows] = await Promise.all([
      runQuery(logs, { logGroup, query: PAGE_VIEWS_QUERY, day, pollMs, sleep }),
      runQuery(logs, { logGroup, query: BOOK_CLICKS_QUERY, day, pollMs, sleep }),
    ]);
    const report = buildReport(rowsToCounts(pageRows, 'views'), rowsToCounts(bookRows, 'clicks'));
    const key = `stats/visits/${day.date}.json`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(report), ContentType: 'application/json' }));
    console.log(JSON.stringify({ visitStats: { key, paths: report.length, views: report.reduce((t, r) => t + r.views, 0) } }));
    return { key };
  };
}
