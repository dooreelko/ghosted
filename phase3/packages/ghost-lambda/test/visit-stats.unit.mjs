import test from 'node:test';
import assert from 'node:assert/strict';
import { previousDay, dayOf, rowsToCounts, buildReport, createVisitStatsHandler } from '../src/visit-stats-app.mjs';

const row = (path, field, n) => [{ field: 'path', value: path }, { field, value: String(n) }];

test('previousDay is the whole previous UTC day', () => {
  const d = previousDay(new Date('2026-11-13T00:30:00Z'));
  assert.equal(d.date, '2026-11-12');
  assert.equal(d.end - d.start, 86400);
  assert.equal(new Date(d.start * 1000).toISOString(), '2026-11-12T00:00:00.000Z');
});

test('dayOf rejects a bad date', () => {
  assert.throws(() => dayOf('yesterday'));
  assert.equal(dayOf('2026-01-02').date, '2026-01-02');
});

test('buildReport is one path/views entry per path, book clicks included, most viewed first', () => {
  const pages = rowsToCounts([row('/', 'views', 10), row('/blog/', 'views', 7), row('/blog/rss/', 'views', 13), row('/blog/a/', 'views', 7)], 'views');
  const book = rowsToCounts([row('/book/qr-202611', 'clicks', 3)], 'clicks');
  assert.deepEqual(buildReport(pages, book), [
    { path: '/blog/rss/', views: 13 },
    { path: '/', views: 10 },
    { path: '/blog/', views: 7 },
    { path: '/blog/a/', views: 7 },
    { path: '/book/qr-202611', views: 3 },
  ]);
});

test('handler queries the previous day and writes stats/visits/<date>.json', async () => {
  const sent = [];
  const logs = {
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === 'StartQueryCommand') { sent.push(cmd.input); return { queryId: String(sent.length) }; }
      const book = cmd.input.queryId === '2';
      return { status: 'Complete', results: book ? [row('/book/qr', 'clicks', 2)] : [row('/', 'views', 5)] };
    },
  };
  const puts = [];
  const s3 = { async send(cmd) { puts.push(cmd.input); } };
  const handler = createVisitStatsHandler({ logGroup: 'lg', bucket: 'b', logs, s3, now: () => new Date('2026-11-13T00:30:00Z'), sleep: async () => {} });
  const out = await handler({});
  assert.equal(out.key, 'stats/visits/2026-11-12.json');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].startTime, Date.UTC(2026, 10, 12) / 1000);
  assert.equal(puts[0].Bucket, 'b');
  const body = JSON.parse(puts[0].Body);
  assert.deepEqual(body, [{ path: '/', views: 5 }, { path: '/book/qr', views: 2 }]);
});

test('a failed query fails the run and writes nothing', async () => {
  const logs = { async send(cmd) { return cmd.constructor.name === 'StartQueryCommand' ? { queryId: 'q' } : { status: 'Failed' }; } };
  const puts = [];
  const handler = createVisitStatsHandler({ logGroup: 'lg', bucket: 'b', logs, s3: { async send(c) { puts.push(c); } }, sleep: async () => {} });
  await assert.rejects(handler({ date: '2026-11-12' }), /Failed/);
  assert.equal(puts.length, 0);
});

test('a result at the row ceiling fails the run instead of writing a truncated report', async () => {
  const rows = Array.from({ length: 10000 }, (_, i) => row(`/p${i}`, 'views', 1));
  const logs = { async send(cmd) { return cmd.constructor.name === 'StartQueryCommand' ? { queryId: 'q' } : { status: 'Complete', results: rows }; } };
  const puts = [];
  const handler = createVisitStatsHandler({ logGroup: 'lg', bucket: 'b', logs, s3: { async send(c) { puts.push(c); } }, sleep: async () => {} });
  await assert.rejects(handler({ date: '2026-11-12' }), /ceiling/);
  assert.equal(puts.length, 0);
});
