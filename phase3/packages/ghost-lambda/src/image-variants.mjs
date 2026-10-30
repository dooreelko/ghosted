// After a crawl: make sure every image the pages use exists in the content
// bucket. Originals were copied at cutover; size variants are generated here
// when missing, so a visitor never waits for the fallback function.
import { buildVariant } from './image-resize-app.mjs';

export async function ensureImages({ store, images, basePath, dimensions, log = () => {}, concurrency = 4 }) {
  const stats = { present: 0, created: 0, unchanged: 0, missing: [], originals: 0 };
  const queue = images.map((rel) => `${basePath}${rel}`); // e.g. /blog/content/images/size/w600/a.jpg
  const work = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const key = p.replace(/^\/+/, '');
      if (await store.exists(key)) { stats.present += 1; continue; }
      if (!p.includes('/content/images/size/')) { stats.missing.push(p); continue; }
      const v = await buildVariant({ store, dimensions, rawPath: p });
      if (v.kind === 'ok') {
        await store.put(key, v.bytes, { contentType: v.contentType, cacheControl: 'public, max-age=31536000, immutable' });
        stats.created += 1;
      } else if (v.kind === 'original') {
        stats.unchanged += 1; // resizing would not change anything; the page serves the original
      } else {
        stats.missing.push(p);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, work));
  log(`images: ${stats.present} present, ${stats.created} created, ${stats.unchanged} left as original, ${stats.missing.length} missing`);
  return stats;
}
