import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';

test('putSegment then getSegment round-trips bytes and metadata', async () => {
  const store = createSegmentStore(createInMemoryObjectStore());
  const id = await store.putSegment(Buffer.from('wal-bytes'), { writeSet: [1, 2, 3] });
  const seg = await store.getSegment(id);
  assert.equal(seg.bytes.toString(), 'wal-bytes');
  assert.deepEqual(seg.meta.writeSet, [1, 2, 3]);
});

test('putSegment ids are unique across calls', async () => {
  const store = createSegmentStore(createInMemoryObjectStore());
  const a = await store.putSegment(Buffer.from('a'));
  const b = await store.putSegment(Buffer.from('b'));
  assert.notEqual(a, b);
});
