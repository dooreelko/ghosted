import { createGeneratorHandler } from './generator-app.mjs';
import { createS3ContentStore } from './content-store.mjs';
import { createQueue } from './queue.mjs';

export const handler = await createGeneratorHandler({
  contentStore: createS3ContentStore({ bucket: process.env.CONTENT_BUCKET }),
  queue: process.env.GENERATE_QUEUE_URL ? createQueue({ url: process.env.GENERATE_QUEUE_URL }) : undefined,
});
