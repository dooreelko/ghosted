import { configure, initCore, initMemberServices, markReady, mark, reportMarks, R, svc } from './runtime.mjs';
import { toHandler } from './express-handler.mjs';

// Webmention receiver (POST /webmentions/receive).
export async function createWebmentionsHandler(opts) {
  const config = await configure(opts);
  await initCore();
  await initMemberServices();
  await svc('server/services/mentions').init({ jobsService: R('server/services/jobs-service') });
  await markReady();
  const root = R('shared/express')('lambda');
  root.use(`${config.getSubdir()}/webmentions`, R('server/web/webmentions')());
  mark('app_built');
  reportMarks();
  return toHandler(root);
}
