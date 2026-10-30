// Ghost's frontend, booted in-process: what the generator crawls and the
// preview function serves. Follows boot.js of the bundled release.
import fs from 'node:fs';
import path from 'node:path';
import { configure, initCore, initMemberServices, markReady, mark, ghostRoot, R } from './runtime.mjs';

const svc = (p) => {
  const m = R(p);
  return m.default ?? m;
};

// Themes ship read-only in the package; Ghost reads them from its content path.
function installThemes() {
  const contentPath = process.env.paths__contentPath;
  const shipped = path.join(ghostRoot, 'content', 'themes');
  if (!fs.existsSync(shipped)) return;
  fs.cpSync(shipped, path.join(contentPath, 'themes'), { recursive: true });
}

export async function createRenderApp({ api = false, ...opts } = {}) {
  const config = await configure(opts);
  installThemes();
  await initCore();
  await svc('server/services/route-settings').init();
  await svc('server/services/custom-redirects').init();
  await svc('server/services/link-redirection').init();
  await svc('server/services/custom-theme-settings').init();
  await svc('server/services/themes').init();
  await svc('server/services/offers').init();
  mark('frontend_services');
  await initMemberServices();
  await Promise.all([svc('server/services/tags-public').init(), svc('server/services/posts-public').init()]);
  svc('frontend/services/helpers').init();

  const parentApp = R('server/web/parent/app')();
  const vhost = require_('@tryghost/mw-vhost');
  const urlService = svc('server/services/url');
  parentApp.use(vhost(config.getFrontendMountPath(), R('server/web/parent/frontend')({ urlService })));
  const routing = R('frontend/services/routing');
  R('bridge').init();
  await svc('server/services/route-settings').service.start({ routerManager: routing.routerManager, urlService });
  await svc('frontend/services/apps').init();

  const root = R('shared/express')('lambda');
  // The content API (the admin one is only reached through its own functions' routes).
  if (api) root.use(`${config.getSubdir()}/ghost/api`, R('server/web/api')());
  root.use(config.getSubdir(), parentApp);
  await markReady();
  mark('render_app_built');
  return { root, config };
}

import { createRequire } from 'node:module';
const require_ = (name) => createRequire(path.join(ghostRoot, 'core', 'x.js'))(name);
