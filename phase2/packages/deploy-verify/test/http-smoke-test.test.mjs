import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrls } from '../src/http-smoke-test.mjs';

test('checkUrls reports ok when every URL returns 200', async () => {
  const fetchImpl = async (url) => ({ status: 200, url });
  const result = await checkUrls(['https://x/blog/', 'https://x/blog/ghost/'], fetchImpl);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [
    { url: 'https://x/blog/', status: 200 },
    { url: 'https://x/blog/ghost/', status: 200 },
  ]);
});

test('checkUrls reports not-ok and keeps checking remaining URLs on a non-200', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/blog/') ? { status: 503, url } : { status: 200, url };
  const result = await checkUrls(['https://x/blog/', 'https://x/blog/ghost/'], fetchImpl);
  assert.equal(result.ok, false);
  assert.deepEqual(result.results, [
    { url: 'https://x/blog/', status: 503 },
    { url: 'https://x/blog/ghost/', status: 200 },
  ]);
});

test('checkUrls reports a fetch rejection as a failure without throwing', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/blog/')) throw new Error('ECONNREFUSED');
    return { status: 200, url };
  };
  const result = await checkUrls(['https://x/blog/', 'https://x/blog/ghost/'], fetchImpl);
  assert.equal(result.ok, false);
  assert.deepEqual(result.results, [
    { url: 'https://x/blog/', error: 'ECONNREFUSED' },
    { url: 'https://x/blog/ghost/', status: 200 },
  ]);
});
