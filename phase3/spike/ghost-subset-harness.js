// Spike harness: boot a SUBSET of Ghost outside its source, report time and
// the JavaScript actually loaded. Usage: node harness.js <subset>
const fs = require('fs');
const t0 = Date.now();
process.chdir('/home/ghost');
const R = (p) => require('/home/ghost/core/' + p);
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] ${m}`);

function report(label) {
  const files = Object.keys(require.cache).filter((f) => f.startsWith('/home/ghost'));
  let total = 0;
  for (const f of files) { try { total += fs.statSync(f).size; } catch {} }
  const pk = new Set(files.map((f) => (f.match(/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)/) || [])[1]).filter(Boolean));
  const m = process.memoryUsage(); console.log(`MEM ${label}: rss=${(m.rss/1e6).toFixed(0)}MB heapUsed=${(m.heapUsed/1e6).toFixed(0)}MB external=${(m.external/1e6).toFixed(0)}MB`);
  console.log(`LOADED ${label}: files=${files.length} js=${(total / 1e6).toFixed(1)}MB packages=${pk.size}`);
}

async function core() {
  const config = R('shared/config');
  const DSM = R('server/data/db/database-state-manager');
  await new DSM({ knexMigratorFilePath: config.get('paths:appRoot') }).makeReady();
  await R('server/data/db/info').init();
  R('server/services/adapter-manager').default.init();
  R('shared/url-utils');
  await R('server/services/limits').init();
  await R('server/services/settings/settings-service').init();
  await R('server/services/i18n').init();
  R('server/services/gift-links').init();
  R('server/services/members-custom-fields').init();
  lap('core ready');
  report('after core');
}

async function memberServices() {
  R('server/services/email-address').init();
  await R('server/services/stripe').init();
  await Promise.all([
    R('server/services/identity-tokens').init(),
    R('server/services/member-attribution').init(),
    R('server/services/members').init(),
    R('server/services/tiers').init(),
    R('server/services/members-events').init(),
    R('server/services/permissions').init(),
    R('server/services/comments').init(),
    R('server/services/email-suppression-list').init(),
    R('server/services/audience-feedback').init(),
  ]);
  lap('member services ready');
}

async function members() {
  await core();
  await memberServices();
  const express = R('shared/express');
  const root = express('spike');
  root.use('/blog/members', R('server/web/members')());
  const server = root.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  lap('listening');
  for (const p of ['/blog/members/api/site/', '/blog/members/api/member/', '/blog/members/api/session/', '/blog/members/api/comments/counts/?ids=abc']) {
    const s = Date.now();
    const r = await fetch(base + p, { headers: { accept: 'application/json' } });
    const b = await r.text();
    console.log(`  ${r.status} ${p} ${Date.now() - s}ms ${b.slice(0, 60).replace(/\n/g, ' ')}`);
  }
  lap('requests done');
  report('after requests');
  server.close();
  process.exit(0);
}

async function render() {
  await core();
  const config = R('shared/config');
  // as boot.js: services for the frontend, helpers, frontend app, routing, apps
  await R('server/services/route-settings').init();
  await R('server/services/custom-redirects').init();
  await R('server/services/link-redirection').init();
  R('server/services/custom-theme-settings').init();
  await R('server/services/themes').init();
  await R('server/services/offers').init();
  lap('frontend services ready');
  await memberServices();
  R('frontend/services/helpers').init();
  const parentApp = R('server/web/parent/app')();
  const vhost = require(require.resolve('@tryghost/mw-vhost', { paths: ['/home/ghost/core'] }));
  const urlService = R('server/services/url');
  parentApp.use(vhost(config.getFrontendMountPath(), R('server/web/parent/frontend')({ urlService })));
  const routing = R('frontend/services/routing');
  const bridge = R('bridge');
  bridge.init();
  await R('server/services/route-settings').service.start({ routerManager: routing.routerManager, urlService });
  await R('frontend/services/apps').init();
  lap('frontend ready');
  const express = R('shared/express');
  const root = express('spike');
  root.use(config.getSubdir(), parentApp);
  const server = root.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const p of ['/blog/', '/blog/rss/', '/blog/sitemap.xml', '/blog/definitely-missing/']) {
    const s = Date.now();
    const r = await fetch(base + p, { redirect: 'manual' });
    const b = await r.text();
    console.log(`  ${r.status} ${p} ${Date.now() - s}ms ${r.headers.get('content-type')} ${b.length}B`);
  }
  lap('requests done');
  report('after requests');
  server.close();
  process.exit(0);
}

const which = process.argv[2];
({ members, render }[which] || (() => { console.log('unknown subset'); }))().catch((e) => { console.log('FAILED', e.stack.split('\n').slice(0, 6).join('\n')); process.exit(1); });
