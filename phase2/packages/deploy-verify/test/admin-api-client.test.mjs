import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  uploadImage,
  createDraftPost,
  getPost,
  deletePost,
  getResourceTotal,
  listRecentPosts,
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

test('uploadImage sets a real image MIME type on the uploaded file, not an empty one', async () => {
  // A real Ghost server rejects a multipart file part with no (or the wrong)
  // Content-Type as 415 "Please select a valid image" -- this was only ever
  // caught by a real end-to-end run against live Ghost, never by the mocked
  // fetch above, which doesn't care what type the Blob claims to be.
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = opts;
    return { ok: true, status: 201, json: async () => ({ images: [{ url: 'https://x/img.png' }] }) };
  };

  await uploadImage('https://x/ghost/api/admin', 'TOKEN', { buffer: Buffer.from([1, 2, 3]), filename: 'test-pixel.png' }, fetchImpl);

  const filePart = seen.body.get('file');
  assert.equal(filePart.type, 'image/png');
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

test('getResourceTotal reads the pagination total for a resource', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ posts: [], meta: { pagination: { total: 42 } } }),
    };
  };

  const total = await getResourceTotal('https://x/api/admin', 'tok', 'posts', fetchImpl);

  assert.equal(total, 42);
  assert.equal(calls[0].url, 'https://x/api/admin/posts/?limit=1');
  assert.equal(calls[0].options.headers.Authorization, 'Ghost tok');
});

test('getResourceTotal applies an NQL filter when one is passed', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ posts: [], meta: { pagination: { total: 7 } } }),
    };
  };

  const total = await getResourceTotal(
    'https://x/api/admin',
    'tok',
    'posts',
    fetchImpl,
    'status:published+type:post'
  );

  assert.equal(total, 7);
  assert.equal(
    calls[0].url,
    'https://x/api/admin/posts/?limit=1&filter=status%3Apublished%2Btype%3Apost'
  );
});

test('getResourceTotal omits the filter param when none is passed', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ meta: { pagination: { total: 1 } } }) };
  };

  await getResourceTotal('https://x/api/admin', 'tok', 'tags', fetchImpl);

  assert.equal(calls[0], 'https://x/api/admin/tags/?limit=1');
});

test('getResourceTotal throws when the response has no pagination total', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ posts: [] }) });

  await assert.rejects(
    () => getResourceTotal('https://x/api/admin', 'tok', 'posts', fetchImpl),
    /no pagination total/
  );
});

test('listRecentPosts requests rendered html and returns the posts', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ posts: [{ id: 'p1', title: 'T', feature_image: null, html: '<p>x</p>' }] }),
    };
  };

  const posts = await listRecentPosts('https://x/api/admin', 'tok', 5, fetchImpl);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].html, '<p>x</p>');
  assert.equal(calls[0], 'https://x/api/admin/posts/?limit=5&formats=html&order=updated_at%20desc');
});
