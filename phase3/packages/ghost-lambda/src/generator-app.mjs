// The generator: renders the public site from a store snapshot and writes it to
// the content bucket. Triggered by the generate queue; idempotent and resumable.
import { createRenderApp } from './render-app.mjs';
import { withStore, mark, reportMarks } from './runtime.mjs';
import { crawl } from './crawl.mjs';

export async function createGeneratorHandler({ objectStore, contentStore, queue } = {}) {
  const { root } = await createRenderApp({ objectStore });
  const server = root.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const port = server.address().port;
  const origin = process.env.GHOST_URL;
  const https = origin.startsWith('https:');
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
      const result = await crawl({ origin, fetchLocal, store: contentStore, log: (m) => console.log(m) });
      if (result.failures.length) console.log('crawl failures', JSON.stringify(result.failures.slice(0, 20)));
      // A run satisfies every request queued meanwhile: drop them.
      const drained = queue ? await queue.drain() : 0;
      return { written: result.written.length, deleted: result.deleted, failures: result.failures.length, drained, ms: Date.now() - started };
    });
  };
}
