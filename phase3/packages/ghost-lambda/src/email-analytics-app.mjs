import { configure, initCore, initMemberServices, invalidateFresh, markReady, mark, reportMarks, withStore, R, svc } from './runtime.mjs';

// Mailgun events poll (opens, deliveries, failures, complaints, unsubscribes) for newsletter
// emails. Ghost runs this as an in-process job every five minutes, which no function here
// can do; an EventBridge schedule starts this function instead and it runs the same fetch
// once. The fetch resumes from cursors kept in the store, so a missed run is caught up by the
// next one. Automation and gift email analytics are not run (no consumer yet).
export async function createEmailAnalyticsHandler(opts) {
  const config = await configure(opts);
  await initCore();
  await initMemberServices();
  svc('server/services/email-analytics').init({
    // Only built when an automation or gift fetch runs, which this function never does.
    automationsApi: R('server/services/automations/automations-api'),
    giftDeliveryService: undefined,
    config,
    db: R('server/data/db'),
    domainEvents: R('../node_modules/@tryghost/domain-events'),
    emailSuppressionList: svc('server/services/email-suppression-list'),
    membersRepository: svc('server/services/members').api.members,
    models: R('server/models'),
    metrics: R('../node_modules/@tryghost/metrics'),
    prometheusClient: undefined,
    settingsCache: R('shared/settings-cache'),
  });
  await markReady();
  mark('app_built');
  reportMarks();
  return async function handler(event, context) {
    if (context) context.callbackWaitsForEmptyEventLoop = false;
    // The send function writes the rows this reads: never trust this copy's snapshot.
    invalidateFresh();
    return withStore(async () => {
      const started = Date.now();
      await svc('server/services/email-analytics').getNewsletters().startFetch();
      const result = { ms: Date.now() - started };
      console.log(JSON.stringify({ emailAnalytics: result }));
      return result;
    });
  };
}
