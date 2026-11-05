import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ensureImages } from '../src/image-variants.mjs';
import { createMemoryContentStore } from '../src/content-store-memory.mjs';

test('creates missing variants, leaves present ones, reports missing originals', async () => {
  const store = createMemoryContentStore();
  const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#f90' } }).png().toBuffer();
  await store.put('blog/content/images/2025/a.png', png);
  await store.put('blog/content/images/size/w600/2025/a.png', Buffer.from('old'));
  const dimensions = { w600: { width: 600 }, w1000: { width: 1000 } };
  const stats = await ensureImages({
    store, basePath: '/blog', dimensions,
    images: ['/content/images/2025/a.png', '/content/images/size/w600/2025/a.png', '/content/images/size/w1000/2025/a.png', '/content/images/2025/gone.png', '/content/images/size/w600/2025/gone.png'],
  });
  assert.equal(stats.present, 2);
  assert.equal(stats.created, 1);
  assert.deepEqual(stats.missing.sort(), ['/blog/content/images/2025/gone.png', '/blog/content/images/size/w600/2025/gone.png']);
  assert.equal((await sharp(store.objects.get('blog/content/images/size/w1000/2025/a.png').bytes).metadata()).width, 800); // not enlarged
  assert.equal(store.objects.get('blog/content/images/size/w600/2025/a.png').bytes.toString(), 'old'); // existing untouched
});
