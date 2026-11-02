import { configure, initCore, initMemberServices, markReady, mark, reportMarks, R, svc } from './runtime.mjs';
import { toHandler } from './express-handler.mjs';

// Webmention receiver (POST /webmentions/receive).
export async function createWebmentionsHandler(opts) {
  const config = await configure(opts);
  await initCore();
  await initMemberServices();
  // Ghost runs a received webmention as a background job after the response; a
  // Lambda is frozen by then, so the job is tracked and awaited before returning.
  const jobsService = R('server/services/jobs-service').init({ knex: R('server/data/db').knex, config });
  const mentions = svc('server/services/mentions');
  await mentions.init({ jobsService });
  const ProcessWebmentionJob = R('server/services/mentions/process-webmention-job').default;
  const inflight = new Set();
  jobsService.handle(
    ProcessWebmentionJob,
    async (job) => {
      const run = mentions.controller.processWebmention(job);
      inflight.add(run);
      try {
        await run;
      } finally {
        inflight.delete(run);
      }
    },
    { queue: 'webmentions', concurrency: 3 },
  );
  await jobsService.start();
  await markReady();
  const root = R('shared/express')('lambda');
  root.use(`${config.getSubdir()}/webmentions`, R('server/web/webmentions')());
  mark('app_built');
  reportMarks();
  return toHandler(root, { after: () => Promise.allSettled([...inflight]) });
}
