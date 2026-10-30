import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImageResizeHandler, allowedDimensions } from './image-resize-app.mjs';
import { createS3ContentStore } from './content-store.mjs';

const themes = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../content/themes');
export const handler = createImageResizeHandler({
  store: createS3ContentStore({ bucket: process.env.CONTENT_BUCKET }),
  dimensions: allowedDimensions(themes),
});
