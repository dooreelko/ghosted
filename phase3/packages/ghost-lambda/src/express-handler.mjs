// Express app -> API Gateway HTTP API (payload 2.0) handler, inside withStore.
import serverlessHttp from 'serverless-http';
import { withStore, shipFailureCount, invalidateFresh } from './runtime.mjs';

const MAX_ATTEMPTS = Number(process.env.WRITE_ATTEMPTS ?? 5);
const backoff = (attempt) => new Promise((r) => setTimeout(r, Math.random() * Math.min(1000, 50 * 2 ** attempt)));

// `after(response)` runs inside the store window once the response is built, for work the
// request started that must finish before the function is frozen.
// `afterCommit(response)` runs once the request's writes are durable in the store (a message
// to another function that reads the store belongs here, not in `after`).
//
// A request that wrote (any method: a GET can record a click or a session) is not answered until its write is in the shared history. The store
// ships a write with a compare-and-swap; when another copy shipped first the write is lost
// (the local file is discarded). The request is then replayed against the fresh state, so the
// caller either sees a durable success or an error, never a success that later vanishes.
// Side effects of the lost attempt (queue messages sent in `after`, one-shot schedules) can
// run twice; the generate message is idempotent.
export function toHandler(app, { after, afterCommit } = {}) {
  const http = serverlessHttp(app);
  return async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    // Test only (admin_url_override): with a separate admin URL Ghost redirects any request whose host is not
    // that URL's host; behind the gateway the host is the gateway's, so present the admin host instead.
    if (process.env.admin__url) event.headers = { ...event.headers, host: new URL(process.env.admin__url).host };
    const method = (event.requestContext?.http?.method ?? 'GET').toUpperCase();
    for (let attempt = 1; ; attempt += 1) {
      const failuresBefore = shipFailureCount();
      const response = await withStore(async () => {
        const res = await http(event, context);
        if (after) await after(res);
        return res;
      });
      if (shipFailureCount() === failuresBefore) {
        if (afterCommit) await withStore(() => afterCommit(response));
        return response;
      }
      console.error(`write lost an optimistic-concurrency race (${method} ${event.rawPath}), attempt ${attempt} of ${MAX_ATTEMPTS}`);
      invalidateFresh();
      if (attempt >= MAX_ATTEMPTS) {
        return { statusCode: 503, headers: { 'content-type': 'application/json', 'retry-after': '1' }, body: JSON.stringify({ errors: [{ message: 'The change could not be saved because of a concurrent update. Please try again.' }] }) };
      }
      await backoff(attempt);
    }
  };
}
