import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  uploadImage,
  createDraftPost,
  getPost,
  deletePost,
} from '../src/admin-api-client.mjs';

test('uploadImage posts multipart form data and returns the image URL', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return {
      ok: true,
      status: 201,
      json: async () => ({ images: [{ url: 'https://bucket.s3.amazonaws.com/2026/09/test-pixel.png' }] }),
    };
  };

  const result = await uploadImage(
    'https://x/ghost/api/admin',
    'TOKEN',
    { buffer: Buffer.from([1, 2, 3]), filename: 'test-pixel.png' },
    fetchImpl,
  );

  assert.equal(result.url, 'https://bucket.s3.amazonaws.com/2026/09/test-pixel.png');
  assert.equal(seen.url, 'https://x/ghost/api/admin/images/upload/');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.Authorization, 'Ghost TOKEN');
  assert.ok(seen.opts.body instanceof FormData);
});

test('createDraftPost posts a draft with the feature image and returns its id', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return {
      ok: true,
      status: 201,
      json: async () => ({ posts: [{ id: 'post123', status: 'draft' }] }),
    };
  };

  const result = await createDraftPost(
    'https://x/ghost/api/admin',
    'TOKEN',
    { title: 'deploy-verify test post', featureImageUrl: 'https://bucket/img.png' },
    fetchImpl,
  );

  assert.equal(result.id, 'post123');
  assert.equal(seen.url, 'https://x/ghost/api/admin/posts/');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.Authorization, 'Ghost TOKEN');
  assert.equal(seen.opts.headers['Content-Type'], 'application/json');
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.posts[0].title, 'deploy-verify test post');
  assert.equal(body.posts[0].status, 'draft');
  assert.equal(body.posts[0].feature_image, 'https://bucket/img.png');
});

test('getPost fetches by id and returns it', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => ({ posts: [{ id: 'post123', status: 'draft' }] }) };
  };

  const result = await getPost('https://x/ghost/api/admin', 'TOKEN', 'post123', fetchImpl);

  assert.deepEqual(result, { id: 'post123', status: 'draft' });
  assert.equal(seen.url, 'https://x/ghost/api/admin/posts/post123/');
  assert.equal(seen.opts.headers.Authorization, 'Ghost TOKEN');
});

test('deletePost issues a DELETE and resolves on success', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 204 };
  };

  await deletePost('https://x/ghost/api/admin', 'TOKEN', 'post123', fetchImpl);

  assert.equal(seen.url, 'https://x/ghost/api/admin/posts/post123/');
  assert.equal(seen.opts.method, 'DELETE');
  assert.equal(seen.opts.headers.Authorization, 'Ghost TOKEN');
});

test('a non-ok response throws with the status and body text', async () => {
  const fetchImpl = async () => ({ ok: false, status: 422, text: async () => 'validation failed' });
  await assert.rejects(
    () => getPost('https://x/ghost/api/admin', 'TOKEN', 'post123', fetchImpl),
    /422.*validation failed/s,
  );
});
