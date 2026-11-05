import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createImageResizeHandler, allowedDimensions } from '../src/image-resize-app.mjs';
import { createMemoryContentStore } from '../src/content-store-memory.mjs';

const dimensions = { ...allowedDimensions('/nonexistent'), w100: { width: 100 } };
const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#09f' } }).png().toBuffer();
const ev = (rawPath) => ({ rawPath });

test('resizes an original, stores the variant, serves it', async () => {
  const store = createMemoryContentStore();
  await store.put('blog/content/images/2025/a.png', png);
  const h = createImageResizeHandler({ store, dimensions });
  const r = await h(ev('/blog/content/images/size/w100/2025/a.png'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'image/png');
  const meta = await sharp(Buffer.from(r.body, 'base64')).metadata();
  assert.equal(meta.width, 100);
  assert.ok(store.objects.has('blog/content/images/size/w100/2025/a.png'));
});

test('format variant', async () => {
  const store = createMemoryContentStore();
  await store.put('blog/content/images/a.png', png);
  const r = await createImageResizeHandler({ store, dimensions })(ev('/blog/content/images/size/w100/format/webp/a.png'));
  assert.equal(r.headers['content-type'], 'image/webp');
  assert.ok(store.objects.has('blog/content/images/size/w100/format/webp/a.png'));
});

test('unknown size redirects to the original, missing original is 404, no enlargement', async () => {
  const store = createMemoryContentStore();
  await store.put('blog/content/images/a.png', png);
  const h = createImageResizeHandler({ store, dimensions });
  const r1 = await h(ev('/blog/content/images/size/w777/a.png'));
  assert.equal(r1.statusCode, 302);
  assert.equal(r1.headers.location, '/blog/content/images/a.png');
  assert.equal((await h(ev('/blog/content/images/size/w100/none.png'))).statusCode, 404);
  const big = await h(ev('/blog/content/images/size/w2400/a.png'));
  assert.equal((await sharp(Buffer.from(big.body, 'base64')).metadata()).width, 400);
});
