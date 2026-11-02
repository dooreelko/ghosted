import { createRenderApp } from './render-app.mjs';
import { toHandler } from './express-handler.mjs';
import { initAdminServices, mark, reportMarks, R, svc, withStore } from './runtime.mjs';
import { createQueue } from './queue.mjs';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// Admin API: Ghost's full service set behind the admin routes. The four admin
// functions run this same app; API Gateway decides which one a route reaches.

// Request paths (under /ghost/api/admin) whose success can change the public site.
const SITE_CHANGING = /^\/(posts|pages|schedules|tags|settings|themes|users|custom_theme_settings|tiers|offers|newsletters|recommendations|redirects)(\/|$)/;

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
  // A newsletter send is its own function when one is named (the long job stays out of the request);
  // the send function itself, and local runs, do the work in place.
  const SendEmailJob = R('server/services/email-service/jobs/send-email-job').default;
  const sendInPlace = (job) => svc('server/services/email-service').service.handleSendEmailJob(job);
  const sendFunction = process.env.EMAIL_SEND_FUNCTION;
  const lambda = sendFunction ? (opts.lambda ?? new LambdaClient({ region: process.env.AWS_REGION })) : null;
  jobs.handle(
    SendEmailJob,
    sendFunction ? (job) => lambda.send(new InvokeCommand({ FunctionName: sendFunction, InvocationType: 'Event', Payload: JSON.stringify({ job }) })) : sendInPlace,
    { queue: 'email', concurrency: 2 },
  );
  // Imports and the media inliner run in the request that starts them (the heavy function has the time).
  jobs.handle(R('server/services/members/jobs/members-import-job').default, (job) => svc('server/services/members').handleImportJob(job));
  jobs.handle(R('server/services/content-import/jobs/content-csv-import-job').default, (job) => svc('server/services/content-import').handleJob(job));
  const siteImporter = R('server/data/importer').init({ jobsService });
  jobs.handle(R('server/data/importer/jobs/content-import-job').default, (job) => siteImporter.executeImport(job));
  jobs.handle(R('server/services/media-inliner/external-media-inliner-job').default, (job) => svc('server/services/media-inliner').getInstance().inline(job.domains));
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
  const handler = toHandler(outer, {
    after: async (response) => {
      await jobs.settled();
      const changed = siteChanged && response.statusCode < 400;
      siteChanged = false;
      if (changed && generateQueue) await generateQueue.send({ reason: 'admin-write' });
    },
  });

  // Entry points for the functions that do one thing with this boot.
  // A scheduled callback (the signed URL Ghost handed the scheduler) goes through the admin app like a request.
  handler.callback = ({ url, method = 'PUT' }) => {
    const u = new URL(url);
    return handler(
      {
        version: '2.0',
        rawPath: u.pathname,
        rawQueryString: u.search.slice(1),
        headers: { host: u.host, 'x-forwarded-proto': u.protocol.slice(0, -1), 'content-type': 'application/json' },
        requestContext: { http: { method, path: u.pathname, sourceIp: '127.0.0.1' } },
        body: method === 'GET' ? undefined : '{}',
        isBase64Encoded: false,
      },
      { callbackWaitsForEmptyEventLoop: false },
    );
  };
  handler.sendEmail = (data) => withStore(() => sendInPlace(new SendEmailJob(data)));
  return handler;
}
