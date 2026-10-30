import { configure, initCore, markReady, mark, reportMarks, withStore, svc } from './runtime.mjs';

// Ghost's recurring cleanups that matter here: expired sign-in tokens and
// expired complimentary memberships. (The gift jobs belong to the paid tier,
// which is not deployed.)
export async function createMaintenanceHandler(opts) {
  await configure(opts);
  await initCore();
  const jobs = svc('server/services/members/jobs');
  jobs.init();
  await markReady();
  mark('app_built');
  reportMarks();
  return async function handler(event, context) {
    if (context) context.callbackWaitsForEmptyEventLoop = false;
    return withStore(async () => {
      const tokens = await jobs.cleanTokens();
      const comped = await jobs.cleanExpiredComped();
      const result = { tokensDeleted: tokens, expiredCompedMembers: comped?.updatedMemberCount ?? comped ?? 0 };
      console.log(JSON.stringify({ maintenance: result }));
      return result;
    });
  };
}
