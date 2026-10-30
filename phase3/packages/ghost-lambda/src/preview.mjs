import { createRenderApp } from './render-app.mjs';
import { toHandler } from './express-handler.mjs';
import { reportMarks } from './runtime.mjs';

// Draft preview, email web view, unsubscribe and gift pages: Ghost's frontend, read-only.
const { root } = await createRenderApp();
reportMarks();
export const handler = toHandler(root);
