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

test('delete then get rejects with NotFound', async () => {
  const store = createInMemoryObjectStore();
  await store.put('k', Buffer.from('a'));
  await store.delete('k');
  await assert.rejects(() => store.get('k'), (err) => err.code === 'NotFound');
});

test('delete on a missing key does not throw', async () => {
  const store = createInMemoryObjectStore();
  await store.delete('never-existed');
});

test('list returns only keys matching the prefix', async () => {
  const store = createInMemoryObjectStore();
  await store.put('segments/a.seg', Buffer.from('a'));
  await store.put('segments/b.seg', Buffer.from('b'));
  await store.put('leases/c', Buffer.from('c'));
  const keys = await store.list('segments/');
  assert.deepEqual(keys.sort(), ['segments/a.seg', 'segments/b.seg']);
});

test('S3-backed store delete maps a 404 to a no-op', async () => {
  const fakeClient = {
    async send() {
      const err = new Error('NoSuchKey');
      err.name = 'NoSuchKey';
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    },
  };
  const store = createS3ObjectStore({ bucket: 'test-bucket', client: fakeClient });
  await store.delete('missing');
});

test('S3-backed store delete rethrows unrelated errors', async () => {
  const fakeClient = {
    async send() {
      const err = new Error('boom');
      err.$metadata = { httpStatusCode: 500 };
      throw err;
    },
  };
  const store = createS3ObjectStore({ bucket: 'test-bucket', client: fakeClient });
  await assert.rejects(() => store.delete('k'), (err) => err.message === 'boom');
});

test('S3-backed store list pages through ListObjectsV2 continuation tokens', async () => {
  const calls = [];
  const fakeClient = {
    async send(command) {
      calls.push(command.input);
      if (!command.input.ContinuationToken) {
        return { Contents: [{ Key: 'segments/a.seg' }], IsTruncated: true, NextContinuationToken: 'tok-2' };
      }
      return { Contents: [{ Key: 'segments/b.seg' }], IsTruncated: false };
    },
  };
  const store = createS3ObjectStore({ bucket: 'test-bucket', client: fakeClient });
  const keys = await store.list('segments/');
  assert.deepEqual(keys, ['segments/a.seg', 'segments/b.seg']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].ContinuationToken, 'tok-2');
});
