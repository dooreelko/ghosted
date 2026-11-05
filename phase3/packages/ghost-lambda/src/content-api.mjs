import { createRenderApp } from './render-app.mjs';
import { toHandler } from './express-handler.mjs';
import { reportMarks } from './runtime.mjs';

// Content API, read-only. It builds resource URLs, so it needs the routing and URL services.
const { root } = await createRenderApp({ api: true });
reportMarks();
export const handler = toHandler(root);
