import test from 'node:test';
import assert from 'node:assert/strict';
import { crawl, keyFor } from '../src/crawl.mjs';
import { createMemoryContentStore } from '../src/content-store-memory.mjs';

const page = (body, type = 'text/html; charset=utf-8') => ({ status: 200, headers: new Map([['content-type', type]]), body: Buffer.from(body) });

test('keyFor maps directories to index.html', () => {
  assert.equal(keyFor('/'), 'index.html');
  assert.equal(keyFor('/rss/'), 'rss/index.html');
  assert.equal(keyFor('/sitemap.xml'), 'sitemap.xml');
});

test('crawl follows links, skips dynamic paths, tracks and prunes its own keys', async () => {
  const site = {
    '/blog/': page('<a href="/blog/about/">a</a><a href="https://x.test/blog/page/2/">2</a><a href="/blog/ghost/">admin</a><a href="https://other.test/">o</a><img src="/blog/assets/a.css?v=1"><img srcset="/blog/content/images/size/w600/a.jpg 600w">'),
    '/blog/about/': page('about'),
    '/blog/page/2/': page('two'),
    '/blog/assets/a.css': page('css', 'text/css'),
    '/blog/sitemap.xml': page('<urlset><url><loc>https://x.test/blog/post/</loc></url></urlset>', 'application/xml'),
    '/blog/post/': page('post'),
  };
  const asked = [];
  const fetchLocal = async (p) => { asked.push(p); return site[p] ?? { status: 404, headers: new Map([['content-type', 'text/html']]), body: Buffer.from('nf') }; };
  const store = createMemoryContentStore();
  await store.put('_generator/keys.json', Buffer.from(JSON.stringify(['blog/old/index.html', 'blog/index.html'])));
  await store.put('blog/old/index.html', Buffer.from('old'));
  await store.put('blog/not-ours.txt', Buffer.from('keep'));

  const r = await crawl({ origin: 'https://x.test/blog', fetchLocal, store });
  assert.ok(store.objects.has('blog/index.html'));
  assert.ok(store.objects.has('blog/about/index.html'));
  assert.ok(store.objects.has('blog/page/2/index.html'));
  assert.ok(store.objects.has('blog/assets/a.css'));
  assert.ok(store.objects.has('blog/post/index.html'));
  assert.ok(store.objects.has('blog/404.html'));
  assert.ok(!asked.some((p) => p.includes('/ghost/') || p.includes('content/images')));
  assert.ok(!store.objects.has('blog/old/index.html'), 'a key this crawl owned and no longer produces is removed');
  assert.ok(store.objects.has('blog/not-ours.txt'), 'a key it never tracked is left alone');
  assert.equal(r.deleted, 1);
});
