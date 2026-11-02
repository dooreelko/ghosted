// Express app -> API Gateway HTTP API (payload 2.0) handler, inside withStore.
import serverlessHttp from 'serverless-http';
import { withStore } from './runtime.mjs';

// `after(response)` runs inside the store window once the response is built, for work the
// request started that must finish before the function is frozen.
export function toHandler(app, { after } = {}) {
  const http = serverlessHttp(app);
  return async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    // Test only (admin_url_override): with a separate admin URL Ghost redirects any request whose host is not
    // that URL's host; behind the gateway the host is the gateway's, so present the admin host instead.
    if (process.env.admin__url) event.headers = { ...event.headers, host: new URL(process.env.admin__url).host };
    return withStore(async () => {
      const response = await http(event, context);
      if (after) await after(response);
      return response;
    });
  };
}
