// phase2/packages/sqlite-s3/test/merge.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { encodePageImages } from '../src/page-images.js';
import { buildMergedFileBytes } from '../src/merge.js';

test('buildMergedFileBytes returns an empty buffer for a null manifest', async () => {
  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const result = await buildMergedFileBytes({ manifest: null, segmentStore });
  assert.equal(result.length, 0);
});

test('buildMergedFileBytes overlays a wal segment onto the base at the correct offset', async () => {
  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const pageSize = 16;
  const baseBytes = Buffer.alloc(pageSize * 2, 0x00);
  const baseSegmentId = await segmentStore.putSegment(baseBytes);
  const walSegmentId = await segmentStore.putSegment(
    encodePageImages([{ pageNumber: 2, bytes: Buffer.alloc(pageSize, 0xaa) }]),
    { dbSizeAfterCommit: 2 }
  );
  const manifest = { baseSegmentId, walSegmentIds: [walSegmentId], pageSize };

  const result = await buildMergedFileBytes({ manifest, segmentStore });
  assert.equal(result.length, pageSize * 2);
  assert.ok(result.subarray(0, pageSize).every((b) => b === 0x00), 'page 1 untouched');
  assert.ok(result.subarray(pageSize, pageSize * 2).every((b) => b === 0xaa), 'page 2 overlaid');
});

test('buildMergedFileBytes truncates to the maximum dbSizeAfterCommit across all segments', async () => {
  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const pageSize = 16;
  const baseBytes = Buffer.alloc(pageSize, 0x00);
  const baseSegmentId = await segmentStore.putSegment(baseBytes);
  // First segment grows the db to 3 pages; second (landing later) only touches page 1
  // with a smaller dbSizeAfterCommit — must NOT truncate away the growth.
  const growSegId = await segmentStore.putSegment(
    encodePageImages([
      { pageNumber: 2, bytes: Buffer.alloc(pageSize, 0x02) },
      { pageNumber: 3, bytes: Buffer.alloc(pageSize, 0x03) },
    ]),
    { dbSizeAfterCommit: 3 }
  );
  const smallSegId = await segmentStore.putSegment(
    encodePageImages([{ pageNumber: 1, bytes: Buffer.alloc(pageSize, 0x99) }]),
    { dbSizeAfterCommit: 1 }
  );
  const manifest = { baseSegmentId, walSegmentIds: [growSegId, smallSegId], pageSize };

  const result = await buildMergedFileBytes({ manifest, segmentStore });
  assert.equal(result.length, pageSize * 3, 'must not truncate away page 2/3 from the growing segment');
});

test('buildMergedFileBytes throws a clear error when pageSize is missing but wal segments exist', async () => {
  const segmentStore = createSegmentStore(createInMemoryObjectStore());
  const manifest = { baseSegmentId: null, walSegmentIds: ['some-id'], pageSize: undefined };
  await assert.rejects(() => buildMergedFileBytes({ manifest, segmentStore }), /pageSize is missing or invalid/);
});
