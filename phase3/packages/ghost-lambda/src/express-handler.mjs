// Express app -> API Gateway HTTP API (payload 2.0) handler, inside withStore.
import serverlessHttp from 'serverless-http';
import { withStore } from './runtime.mjs';

// `after` runs inside the store window once the response is built, for work the
// request started that must finish before the function is frozen.
export function toHandler(app, { after } = {}) {
  const http = serverlessHttp(app);
  return async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    return withStore(async () => {
      const response = await http(event, context);
      if (after) await after();
      return response;
    });
  };
}
