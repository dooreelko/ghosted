import { configure, initCore, initMemberServices, markReady, mark, reportMarks, R, svc } from './runtime.mjs';
import { toHandler } from './express-handler.mjs';

// Newsletter click-tracking redirect (/r/<slug>): looks the link up, records the
// click for a known member, redirects. Ghost's own service does all of it.
export async function createLinkRedirectHandler(opts) {
  const config = await configure(opts);
  await initCore();
  await svc('server/services/link-redirection').init();
  await initMemberServices();
  await svc('server/services/link-tracking').init();
  await markReady();
  const redirects = svc('server/services/link-redirection');
  const root = R('shared/express')('lambda');
  root.get(`${config.getSubdir()}${redirects.service.relativeRedirectPrefix()}*`, redirects.service.handleRequest);
  mark('app_built');
  reportMarks();
  return toHandler(root);
}
