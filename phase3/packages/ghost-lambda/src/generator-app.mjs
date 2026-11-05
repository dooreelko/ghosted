// The generator: renders the public site from a store snapshot and writes it to
// the content bucket. Triggered by the generate queue; idempotent and resumable.
import { createRenderApp } from './render-app.mjs';
import { withStore, mark, reportMarks } from './runtime.mjs';
import { crawl } from './crawl.mjs';
import { ensureImages } from './image-variants.mjs';
import { allowedDimensions } from './image-resize-app.mjs';
import { createInvalidator } from './invalidate.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function createGeneratorHandler({ objectStore, contentStore, queue, invalidate } = {}) {
  const { root } = await createRenderApp({ objectStore });
  const server = root.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const port = server.address().port;
  const origin = process.env.GHOST_URL;
  const https = origin.startsWith('https:');
  const basePath = new URL(origin).pathname.replace(/\/+$/, '');
  const dimensions = allowedDimensions(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../content/themes'));
  invalidate ??= createInvalidator({ distributionId: process.env.DISTRIBUTION_ID, enabled: process.env.INVALIDATE === '1', basePath });
  mark('listening');
  reportMarks();

  const fetchLocal = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-proto': https ? 'https' : 'http', host: new URL(origin).host },
    });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  };

  return async function handler(event, context) {
    context.callbackWaitsForEmptyEventLoop = false;
    return withStore(async () => {
      const started = Date.now();
      // Two passes: on a cold start Ghost's image-size lookups can miss for a few images (the page
      // then lacks their dimensions); the second pass has the successful lookups cached and gets the rest.
      await crawl({ origin, fetchLocal, store: contentStore, log: (m) => console.log(`pass 1: ${m}`) });
      const result = await crawl({ origin, fetchLocal, store: contentStore, log: (m) => console.log(m) });
      if (result.failures.length) console.log('crawl failures', JSON.stringify(result.failures.slice(0, 20)));
      // Images before the invalidation: a page never points at an image that is not there yet.
      const images = await ensureImages({ store: contentStore, images: result.images, basePath, dimensions, log: (m) => console.log(m) });
      if (images.missing.length) console.log('images missing', JSON.stringify(images.missing.slice(0, 20)));
      const inv = await invalidate();
      // A run satisfies every request queued meanwhile: drop them.
      const drained = queue ? await queue.drain() : 0;
      return { written: result.written.length, deleted: result.deleted, failures: result.failures.length, images: { present: images.present, created: images.created, unchanged: images.unchanged, missing: images.missing.length }, invalidated: inv.invalidated, drained, ms: Date.now() - started };
    });
  };
}
