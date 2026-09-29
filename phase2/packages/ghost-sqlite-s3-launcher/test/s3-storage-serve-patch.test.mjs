import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originalImageUrl, serveViaOriginal, patchS3StorageServe } from '../src/s3-storage-serve-patch.mjs';

function fakeRes() {
  return {
    headers: {},
    redirected: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    redirect(status, url) {
      this.redirected = { status, url };
    },
  };
}

test('originalImageUrl strips the size segment', () => {
  assert.equal(
    originalImageUrl('/size/w1200/2026/09/flappy.png', '/blog/content/images/size/w1200/2026/09/flappy.png'),
    '/blog/content/images/2026/09/flappy.png',
  );
});

test('originalImageUrl strips size and format segments', () => {
  assert.equal(
    originalImageUrl('/size/w600/format/webp/2026/09/flappy.png', '/blog/content/images/size/w600/format/webp/2026/09/flappy.png'),
    '/blog/content/images/2026/09/flappy.png',
  );
});

test('originalImageUrl returns null for a non-variant path', () => {
  assert.equal(originalImageUrl('/2026/09/flappy.png', '/blog/content/images/2026/09/flappy.png'), null);
});

test('originalImageUrl collapses leading slashes', () => {
  assert.equal(originalImageUrl('/size/w1200//evil.com/x.png', '/size/w1200//evil.com/x.png'), '/evil.com/x.png');
});

test('serveViaOriginal answers a variant with an uncacheable 302 to the original', () => {
  const res = fakeRes();
  let nextCalled = false;
  serveViaOriginal(
    { path: '/size/w1920/2026/09/flappy.png', originalUrl: '/blog/content/images/size/w1920/2026/09/flappy.png' },
    res,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, false);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.redirected, { status: 302, url: '/blog/content/images/2026/09/flappy.png' });
});

test('serveViaOriginal falls through for a non-variant path instead of redirecting to itself', () => {
  const res = fakeRes();
  let nextCalled = false;
  serveViaOriginal(
    { path: '/2026/09/flappy.png', originalUrl: '/blog/content/images/2026/09/flappy.png' },
    res,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, true);
  assert.equal(res.redirected, null);
});

test('patchS3StorageServe replaces serve() on the class', () => {
  class FakeS3Storage {
    serve() {
      return () => 'original';
    }
  }
  patchS3StorageServe(FakeS3Storage);
  assert.equal(new FakeS3Storage().serve(), serveViaOriginal);
});

test('patchS3StorageServe throws when serve() is missing', () => {
  assert.throws(() => patchS3StorageServe(class {}), /serve not found/);
  assert.throws(() => patchS3StorageServe(undefined), /serve not found/);
});
