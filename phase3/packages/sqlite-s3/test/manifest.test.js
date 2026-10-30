import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createManifestStore, ManifestConflictError } from '../src/manifest.js';

test('read on an empty store returns null manifest and null etag', async () => {
  const m = createManifestStore(createInMemoryObjectStore());
  const { manifest, etag } = await m.read();
  assert.equal(manifest, null);
  assert.equal(etag, null);
});

test('first write with expectedEtag: null succeeds', async () => {
  const m = createManifestStore(createInMemoryObjectStore());
  const { etag } = await m.write({ baseSegmentId: null, walSegmentIds: ['a'] }, { expectedEtag: null });
  assert.ok(etag);
  const read = await m.read();
  assert.deepEqual(read.manifest, { baseSegmentId: null, walSegmentIds: ['a'] });
});

test('write with a stale expectedEtag throws ManifestConflictError carrying the current state', async () => {
  const m = createManifestStore(createInMemoryObjectStore());
  const first = await m.write({ baseSegmentId: null, walSegmentIds: ['a'] }, { expectedEtag: null });
  await assert.rejects(
    () => m.write({ baseSegmentId: null, walSegmentIds: ['a', 'stale-write'] }, { expectedEtag: 'not-real' }),
    (err) => {
      assert.ok(err instanceof ManifestConflictError);
      assert.deepEqual(err.current.manifest.walSegmentIds, ['a']);
      assert.equal(err.current.etag, first.etag);
      return true;
    }
  );
});

test('write with the correct expectedEtag succeeds and advances the etag', async () => {
  const m = createManifestStore(createInMemoryObjectStore());
  const first = await m.write({ baseSegmentId: null, walSegmentIds: ['a'] }, { expectedEtag: null });
  const second = await m.write({ baseSegmentId: null, walSegmentIds: ['a', 'b'] }, { expectedEtag: first.etag });
  assert.notEqual(second.etag, first.etag);
  const read = await m.read();
  assert.deepEqual(read.manifest.walSegmentIds, ['a', 'b']);
});
