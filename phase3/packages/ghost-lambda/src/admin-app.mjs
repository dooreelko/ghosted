import { createRenderApp } from './render-app.mjs';
import { toHandler } from './express-handler.mjs';
import { initAdminServices, mark, reportMarks, R, svc } from './runtime.mjs';
import { createQueue } from './queue.mjs';

// Admin API: Ghost's full service set behind the admin routes. The four admin
// functions run this same app; API Gateway decides which one a route reaches.

// Request paths (under /ghost/api/admin) whose success can change the public site.
const SITE_CHANGING = /^\/(posts|pages|tags|settings|themes|users|custom_theme_settings|tiers|offers|newsletters|recommendations|redirects)(\/|$)/;

// Ghost runs background work after the response; a Lambda is frozen by then, so
// handlers are tracked and awaited before the function returns.
function trackedJobs(jobsService) {
  const inflight = new Set();
  const track = (fn) => async (job) => {
    const run = Promise.resolve().then(() => fn(job));
    inflight.add(run);
    try {
      return await run;
    } finally {
      inflight.delete(run);
    }
  };
  return {
    handle: (JobClass, fn, options) => jobsService.handle(JobClass, track(fn), options),
    settled: async () => {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };
}

export async function createAdminHandler(opts = {}) {
  const { root, config } = await createRenderApp({ api: true, ...opts });
  const jobsService = R('server/services/jobs-service').init({ knex: R('server/data/db').knex, config });
  await initAdminServices({ jobsService });

  const jobs = trackedJobs(jobsService);
  const mentions = svc('server/services/mentions');
  jobs.handle(R('server/services/mentions/process-webmention-job').default, (job) => mentions.controller.processWebmention(job), { queue: 'webmentions', concurrency: 3 });
  jobs.handle(R('server/services/mentions/send-webmentions-job').default, (job) => mentions.sendingService.sendWebmentions(job), { queue: 'webmentions', concurrency: 3 });
  jobs.handle(R('server/services/email-service/jobs/send-email-job').default, (job) => svc('server/services/email-service').service.handleSendEmailJob(job), { queue: 'email', concurrency: 2 });
  await jobsService.start();

  // A write that can change the site asks for a regeneration when it succeeds.
  const generateQueue = opts.queue ?? (process.env.GENERATE_QUEUE_URL ? createQueue({ url: process.env.GENERATE_QUEUE_URL }) : null);
  let siteChanged = false;
  const adminBase = `${config.getSubdir()}/ghost/api/admin`;
  const outer = R('shared/express')('lambda');
  outer.use(adminBase, (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && SITE_CHANGING.test(req.path)) {
      siteChanged = true;
    }
    next();
  });
  outer.use(root);

  mark('admin_app_built');
  reportMarks();
  return toHandler(outer, {
    after: async (response) => {
      await jobs.settled();
      const changed = siteChanged && response.statusCode < 400;
      siteChanged = false;
      if (changed && generateQueue) await generateQueue.send({ reason: 'admin-write' });
    },
  });
}
