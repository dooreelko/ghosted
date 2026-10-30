// Express app -> API Gateway HTTP API (payload 2.0) handler, inside withStore.
import serverlessHttp from 'serverless-http';
import { withStore } from './runtime.mjs';

export function toHandler(app) {
  const http = serverlessHttp(app);
  return async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    return withStore(() => http(event, context));
  };
}
