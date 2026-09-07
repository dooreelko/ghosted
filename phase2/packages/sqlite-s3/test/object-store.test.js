import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore, createS3ObjectStore } from '../src/object-store.js';

test('put then get round-trips bytes and returns a stable etag', async () => {
  const store = createInMemoryObjectStore();
  const { etag } = await store.put('k', Buffer.from('hello'));
  const got = await store.get('k');
  assert.equal(got.bytes.toString(), 'hello');
  assert.equal(got.etag, etag);
});

test('get on a missing key rejects with code NotFound', async () => {
  const store = createInMemoryObjectStore();
  await assert.rejects(() => store.get('missing'), (err) => err.code === 'NotFound');
});

test('ifNoneMatch:true rejects with PreconditionFailed if the key already exists', async () => {
  const store = createInMemoryObjectStore();
  await store.put('k', Buffer.from('a'));
  await assert.rejects(
    () => store.put('k', Buffer.from('b'), { ifNoneMatch: true }),
    (err) => err.code === 'PreconditionFailed'
  );
});

test('ifMatch rejects with PreconditionFailed if the etag is stale', async () => {
  const store = createInMemoryObjectStore();
  await store.put('k', Buffer.from('a'));
  await assert.rejects(
    () => store.put('k', Buffer.from('b'), { ifMatch: 'not-the-real-etag' }),
    (err) => err.code === 'PreconditionFailed'
  );
});

test('ifMatch succeeds when the etag matches, and updates the etag', async () => {
  const store = createInMemoryObjectStore();
  const first = await store.put('k', Buffer.from('a'));
  const second = await store.put('k', Buffer.from('b'), { ifMatch: first.etag });
  const got = await store.get('k');
  assert.equal(got.bytes.toString(), 'b');
  assert.equal(got.etag, second.etag);
});

test('S3-backed store maps a 409 ConditionalRequestConflict to PreconditionFailed', async () => {
  const fakeClient = {
    async send() {
      const err = new Error('ConditionalRequestConflict');
      err.name = 'ConditionalRequestConflict';
      err.$metadata = { httpStatusCode: 409 };
      throw err;
    },
  };
  const store = createS3ObjectStore({ bucket: 'test-bucket', client: fakeClient });
  await assert.rejects(
    () => store.put('k', Buffer.from('a'), { ifNoneMatch: true }),
    (err) => err.code === 'PreconditionFailed'
  );
});

test('S3-backed store maps a 412 precondition failure to PreconditionFailed', async () => {
  const fakeClient = {
    async send() {
      const err = new Error('PreconditionFailed');
      err.name = 'PreconditionFailed';
      err.$metadata = { httpStatusCode: 412 };
      throw err;
    },
  };
  const store = createS3ObjectStore({ bucket: 'test-bucket', client: fakeClient });
  await assert.rejects(
    () => store.put('k', Buffer.from('a'), { ifNoneMatch: true }),
    (err) => err.code === 'PreconditionFailed'
  );
});

test('S3-backed store rethrows unrelated errors unchanged', async () => {
  const fakeClient = {
    async send() {
      const err = new Error('boom');
      err.$metadata = { httpStatusCode: 500 };
      throw err;
    },
  };
  const store = createS3ObjectStore({ bucket: 'test-bucket', client: fakeClient });
  await assert.rejects(
    () => store.put('k', Buffer.from('a'), { ifNoneMatch: true }),
    (err) => err.message === 'boom' && err.code === undefined
  );
});
