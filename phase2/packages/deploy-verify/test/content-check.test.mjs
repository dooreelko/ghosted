import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractImageUrls,
  imageUrlToKey,
  makeS3ImageChecker,
  makeHttpImageChecker,
  checkContent,
} from '../src/content-check.mjs';

test('extractImageUrls collects the feature image and every img src', () => {
  const post = {
    feature_image: 'https://site/blog/content/images/2026/01/hero.png',
    html: '<p>hi</p><img src="https://site/blog/content/images/2026/01/a.png"><img src=\'https://site/blog/content/images/b.png\' alt="x">',
  };

  assert.deepEqual(extractImageUrls(post), [
    'https://site/blog/content/images/2026/01/hero.png',
    'https://site/blog/content/images/2026/01/a.png',
    'https://site/blog/content/images/b.png',
  ]);
});

test('extractImageUrls tolerates a post with no images', () => {
  assert.deepEqual(extractImageUrls({ feature_image: null, html: '<p>text</p>' }), []);
});

test('extractImageUrls tolerates a post with no html', () => {
  assert.deepEqual(extractImageUrls({ feature_image: null, html: null }), []);
});

test('extractImageUrls de-duplicates repeats', () => {
  const post = {
    feature_image: 'https://site/blog/content/images/a.png',
    html: '<img src="https://site/blog/content/images/a.png">',
  };
  assert.deepEqual(extractImageUrls(post), ['https://site/blog/content/images/a.png']);
});

test('extractImageUrls pulls candidates out of a srcset-only image', () => {
  const post = {
    feature_image: null,
    html: '<img srcset="https://site/blog/content/images/small.png 400w, https://site/blog/content/images/large.png 800w">',
  };

  assert.deepEqual(extractImageUrls(post), [
    'https://site/blog/content/images/small.png',
    'https://site/blog/content/images/large.png',
  ]);
});

test('extractImageUrls de-duplicates a src that also appears in srcset', () => {
  const post = {
    feature_image: null,
    html: '<img src="https://site/blog/content/images/a.png" srcset="https://site/blog/content/images/a.png 1x, https://site/blog/content/images/a-2x.png 2x">',
  };

  assert.deepEqual(extractImageUrls(post), [
    'https://site/blog/content/images/a.png',
    'https://site/blog/content/images/a-2x.png',
  ]);
});

test('imageUrlToKey drops the origin and the leading slash', () => {
  assert.equal(
    imageUrlToKey('https://site/blog/content/images/2026/01/hero.png'),
    'blog/content/images/2026/01/hero.png'
  );
});

test('imageUrlToKey decodes percent-escapes so the key matches the stored object', () => {
  assert.equal(
    imageUrlToKey('https://site/blog/content/images/my%20photo.png'),
    'blog/content/images/my photo.png'
  );
});

test('makeS3ImageChecker heads the mapped key in the data bucket', async () => {
  const seen = [];
  const s3Client = {
    async send(command) {
      seen.push(command.input);
      return {};
    },
  };

  const check = makeS3ImageChecker({ bucket: 'data-bucket', s3Client });
  assert.equal(await check('https://site/blog/content/images/a.png'), true);
  assert.equal(seen[0].Bucket, 'data-bucket');
  assert.equal(seen[0].Key, 'blog/content/images/a.png');
});

test('makeS3ImageChecker reports false for a missing object', async () => {
  const s3Client = {
    async send() {
      const err = new Error('not found');
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    },
  };

  const check = makeS3ImageChecker({ bucket: 'data-bucket', s3Client });
  assert.equal(await check('https://site/blog/content/images/gone.png'), false);
});

test('makeS3ImageChecker skips a URL whose host is not the site host', async () => {
  const seen = [];
  const s3Client = {
    async send(command) {
      seen.push(command.input);
      return {};
    },
  };

  const check = makeS3ImageChecker({ bucket: 'data-bucket', s3Client, siteHost: 'site' });
  assert.equal(await check('https://cdn.example/blog/content/images/a.png'), 'skipped');
  assert.deepEqual(seen, []);
});

test('makeS3ImageChecker still checks a same-host URL when siteHost is set', async () => {
  const seen = [];
  const s3Client = {
    async send(command) {
      seen.push(command.input);
      return {};
    },
  };

  const check = makeS3ImageChecker({ bucket: 'data-bucket', s3Client, siteHost: 'site' });
  assert.equal(await check('https://site/blog/content/images/a.png'), true);
  assert.equal(seen[0].Key, 'blog/content/images/a.png');
});

test('makeHttpImageChecker reports true only on a 200', async () => {
  const ok = makeHttpImageChecker(async () => ({ status: 200 }));
  const missing = makeHttpImageChecker(async () => ({ status: 404 }));
  const broken = makeHttpImageChecker(async () => {
    throw new Error('ECONNREFUSED');
  });

  assert.equal(await ok('https://site/x.png'), true);
  assert.equal(await missing('https://site/x.png'), false);
  assert.equal(await broken('https://site/x.png'), false);
});

function fakeApi({ totals, posts }) {
  return async (url) => {
    if (url.includes('?limit=1')) {
      const resource = url.match(/admin\/(\w+)\//)[1];
      return {
        ok: true,
        status: 200,
        json: async () => ({ meta: { pagination: { total: totals[resource] } } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ posts }) };
  };
}

test('checkContent passes when counts match and every image resolves', async () => {
  const fetchImpl = fakeApi({
    totals: { users: 1, tags: 3 },
    posts: [{ id: 'p1', feature_image: 'https://site/blog/content/images/a.png', html: '' }],
  });

  const result = await checkContent({
    adminBase: 'https://site/blog/ghost/api/admin',
    token: 'tok',
    expected: { users: 1, tags: 3 },
    imageChecker: async () => true,
    fetchImpl,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.differences, []);
  assert.deepEqual(result.missingImages, []);
});

test('checkContent fails on a count mismatch', async () => {
  const fetchImpl = fakeApi({
    totals: { users: 1, tags: 2 },
    posts: [{ id: 'p1', feature_image: null, html: '' }],
  });

  const result = await checkContent({
    adminBase: 'https://site/blog/ghost/api/admin',
    token: 'tok',
    expected: { users: 1, tags: 3 },
    imageChecker: async () => true,
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.differences, [{ resource: 'tags', expected: 3, actual: 2 }]);
});

test('checkContent fails and names every image that does not resolve', async () => {
  const fetchImpl = fakeApi({
    totals: { users: 1, tags: 0 },
    posts: [
      {
        id: 'p1',
        feature_image: 'https://site/blog/content/images/good.png',
        html: '<img src="https://site/blog/content/images/bad.png">',
      },
    ],
  });

  const result = await checkContent({
    adminBase: 'https://site/blog/ghost/api/admin',
    token: 'tok',
    expected: { users: 1, tags: 0 },
    imageChecker: async (url) => !url.endsWith('bad.png'),
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingImages, [
    { postId: 'p1', url: 'https://site/blog/content/images/bad.png' },
  ]);
});

test('checkContent fails when no posts come back, even if counts match', async () => {
  const fetchImpl = fakeApi({ totals: { users: 1, tags: 0 }, posts: [] });

  const result = await checkContent({
    adminBase: 'https://site/blog/ghost/api/admin',
    token: 'tok',
    expected: { users: 1, tags: 0 },
    imageChecker: async () => true,
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.differences, [
    { resource: 'posts', expected: 'at least one post to check', actual: 0 },
  ]);
  assert.equal(result.postsChecked, 0);
  assert.equal(result.imagesChecked, 0);
});

test('checkContent reports how many posts and images were checked on success', async () => {
  const fetchImpl = fakeApi({
    totals: { users: 1, tags: 0 },
    posts: [
      {
        id: 'p1',
        feature_image: 'https://site/blog/content/images/a.png',
        html: '<img src="https://site/blog/content/images/b.png">',
      },
    ],
  });

  const result = await checkContent({
    adminBase: 'https://site/blog/ghost/api/admin',
    token: 'tok',
    expected: { users: 1, tags: 0 },
    imageChecker: async () => true,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.postsChecked, 1);
  assert.equal(result.imagesChecked, 2);
});

test('checkContent collects a skipped external image separately instead of dropping it', async () => {
  const fetchImpl = fakeApi({
    totals: { users: 1, tags: 0 },
    posts: [
      {
        id: 'p1',
        feature_image: 'https://site/blog/content/images/a.png',
        html: '<img src="https://cdn.example/x.png">',
      },
    ],
  });

  const imageChecker = async (url) => (url.includes('cdn.example') ? 'skipped' : true);

  const result = await checkContent({
    adminBase: 'https://site/blog/ghost/api/admin',
    token: 'tok',
    expected: { users: 1, tags: 0 },
    imageChecker,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.skippedExternalImages, [
    { postId: 'p1', url: 'https://cdn.example/x.png' },
  ]);
  assert.equal(result.imagesChecked, 1);
});
