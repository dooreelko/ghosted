import { configure, initCore, initMemberServices, markReady, R } from './runtime.mjs';
import { toHandler } from './express-handler.mjs';

// Members app: session, member, sign-in, site info (the R3 function).
export async function createMembersHandler(opts) {
  const config = await configure(opts);
  await initCore();
  await initMemberServices();
  await markReady();
  const root = R('shared/express')('lambda');
  root.use(`${config.getSubdir()}/members`, R('server/web/members')());
  return toHandler(root);
}
