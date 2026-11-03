// CloudWatch gate: after a test run, check that nothing in the time window went wrong.
// Plain node, uses the aws CLI. Exit 1 on any failure.
//   node cloudwatch-gate.mjs --since 2026-11-03T10:00:00Z [--until <iso>] [--settle 120] [--prefix ghost-phase3]
// Metrics lag by a minute or two, so it waits --settle seconds before reading them (0 to skip).
import { execFileSync } from 'node:child_process';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const since = arg('since'); if (!since) { console.error('--since <iso time> is required'); process.exit(2); }
const prefix = arg('prefix', 'ghost-phase3');
const settle = Number(arg('settle', 120));
const aws = (...a) => { const out = execFileSync('aws', [...a, '--output', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return out.trim() ? JSON.parse(out) : null; };

if (settle > 0) { console.log(`waiting ${settle}s for metrics to settle`); await new Promise((r) => setTimeout(r, settle * 1000)); }
const until = arg('until', new Date().toISOString());
const sum = (name, ns, dims) => {
  const d = aws('cloudwatch', 'get-metric-statistics', '--namespace', ns, '--metric-name', name, '--dimensions', ...dims.map(([k, v]) => `Name=${k},Value=${v}`),
    '--start-time', since, '--end-time', until, '--period', '60', '--statistics', 'Sum');
  return (d?.Datapoints ?? []).reduce((a, p) => a + p.Sum, 0);
};

const failures = [];
const warnings = [];
const rows = [];
const check = (name, bad, detail = '') => { rows.push([bad ? 'FAIL' : 'ok', name, detail]); if (bad) failures.push(name); };

// 1. alarms: none in ALARM now, none that went into ALARM during the window
const alarms = aws('cloudwatch', 'describe-alarms', '--alarm-name-prefix', prefix).MetricAlarms;
const inAlarm = alarms.filter((a) => a.StateValue !== 'OK').map((a) => a.AlarmName);
check(`alarms (${alarms.length}) all OK now`, inAlarm.length > 0, inAlarm.join(', '));
const history = aws('cloudwatch', 'describe-alarm-history', '--history-item-type', 'StateUpdate', '--start-date', since, '--end-date', until, '--max-records', '100').AlarmHistoryItems
  .filter((h) => h.AlarmName.startsWith(prefix) && /to ALARM/.test(h.HistorySummary));
check('no alarm went into ALARM during the window', history.length > 0, history.map((h) => `${h.AlarmName}@${h.Timestamp}`).join(', '));

// 2. API Gateway 5xx
const api = aws('apigatewayv2', 'get-apis').Items.find((a) => a.Name.includes(prefix.replace(/^ghost-/, '')) || a.Name.startsWith(prefix));
if (api) check('API gateway 5xx = 0', sum('5xx', 'AWS/ApiGateway', [['ApiId', api.ApiId]]) > 0, `count ${sum('5xx', 'AWS/ApiGateway', [['ApiId', api.ApiId]])}`);
else warnings.push('no API found for the prefix; 5xx not checked');

// 3. Lambda errors and throttles per function
const fns = aws('lambda', 'list-functions').Functions.map((f) => f.FunctionName).filter((n) => n.startsWith(prefix));
for (const metric of ['Errors', 'Throttles']) {
  const bad = fns.map((f) => [f, sum(metric, 'AWS/Lambda', [['FunctionName', f]])]).filter(([, n]) => n > 0);
  check(`Lambda ${metric} = 0 (${fns.length} functions)`, bad.length > 0, bad.map(([f, n]) => `${f}:${n}`).join(', '));
}

// 4. dead-letter queue empty
const queues = (aws('sqs', 'list-queues', '--queue-name-prefix', prefix)?.QueueUrls ?? []).filter((u) => /dlq|dead/i.test(u));
for (const url of queues) {
  const n = Number(aws('sqs', 'get-queue-attributes', '--queue-url', url, '--attribute-names', 'ApproximateNumberOfMessages').Attributes.ApproximateNumberOfMessages);
  check('dead-letter queue empty', n > 0, `${n} messages`);
}
if (!queues.length) warnings.push('no dead-letter queue found; not checked');

// 5. function logs: timeouts and failed store ships fail; init timeouts (cold boot retried inside the request) only warn
const hard = /Task timed out|async commit ship failed|Runtime\.|Unhandled|"errorType"/;
const initTimeout = /Phase: init\s+Status: timeout/;
const t0 = Date.parse(since), t1 = Date.parse(until);
let initTimeouts = 0;
const hardHits = [];
for (const f of fns) {
  let token;
  do {
    const args = ['logs', 'filter-log-events', '--log-group-name', `/aws/lambda/${f}`, '--start-time', String(t0), '--end-time', String(t1),
      '--filter-pattern', '?"Task timed out" ?"commit ship failed" ?Runtime ?Unhandled ?errorType ?"Phase: init"'];
    if (token) args.push('--next-token', token);
    let page;
    try { page = aws(...args); } catch { break; } // a function with no log group yet
    for (const e of page?.events ?? []) {
      if (initTimeout.test(e.message)) initTimeouts += 1;
      else if (hard.test(e.message)) hardHits.push(`${f}: ${e.message.trim().slice(0, 140)}`);
    }
    token = page?.nextToken;
  } while (token);
}
check('no timeouts, unhandled errors or failed store ships in the logs', hardHits.length > 0, hardHits.slice(0, 5).join(' | '));
if (initTimeouts) warnings.push(`${initTimeouts} cold boot(s) exceeded Lambda's 10 s init limit (retried inside the request; slow first call, not an error)`);

console.log(`\nCloudWatch gate ${since} .. ${until}`);
for (const [s, n, d] of rows) console.log(`  ${s.padEnd(4)} ${n}${d ? `  [${d}]` : ''}`);
for (const w of warnings) console.log(`  warn ${w}`);
console.log(failures.length ? `\nGATE FAILED: ${failures.length} check(s)` : '\nGATE PASSED');
process.exit(failures.length ? 1 : 0);
