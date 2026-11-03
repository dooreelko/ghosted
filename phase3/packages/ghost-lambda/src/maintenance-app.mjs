import { configure, initCore, markReady, mark, reportMarks, withStore, svc } from './runtime.mjs';

// Ghost's recurring cleanups that matter here: expired sign-in tokens and
// expired complimentary memberships. (The gift jobs belong to the paid tier,
// which is not deployed.)
//
// Also the only place migrations run: invoke with `{ "migrate": true }` after deploying a
// Ghost version that has some (every other function refuses to start until it is done).
export async function createMaintenanceHandler(opts) {
  await configure(opts);
  // The maintenance function boots even on an unmigrated store, so it can migrate it.
  let migrate = false;
  try { await initCore(); } catch (err) { console.error(String(err.message)); migrate = true; }
  if (migrate) {
    return async function migrateOnly(event, context) {
      if (context) context.callbackWaitsForEmptyEventLoop = false;
      if (!event?.migrate) throw new Error('database needs migration: invoke with {"migrate": true}');
      return withStore(async () => {
        await initCore({ migrate: true });
        await markReady();
        console.log(JSON.stringify({ migrated: true }));
        return { migrated: true, note: 'redeploy or wait for copies to restart' };
      });
    };
  }
  const jobs = svc('server/services/members/jobs');
  jobs.init();
  await markReady();
  mark('app_built');
  reportMarks();
  return async function handler(event, context) {
    if (context) context.callbackWaitsForEmptyEventLoop = false;
    if (event?.migrate) return { migrated: false, note: 'nothing to migrate' };
    return withStore(async () => {
      const tokens = await jobs.cleanTokens();
      const comped = await jobs.cleanExpiredComped();
      const result = { tokensDeleted: tokens, expiredCompedMembers: comped?.updatedMemberCount ?? comped ?? 0 };
      console.log(JSON.stringify({ maintenance: result }));
      return result;
    });
  };
}
