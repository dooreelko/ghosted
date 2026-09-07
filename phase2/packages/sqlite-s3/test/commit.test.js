import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { createManifestStore } from '../src/manifest.js';
import { createCommitter } from '../src/commit.js';

const PAGE_SIZE = 4096;

function setup() {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const committer = createCommitter({ manifestStore, segmentStore, sleep: async () => {} });
  return { segmentStore, manifestStore, committer };
}

test('first commit ever writes a manifest with baseSegmentId null and records pageSize', async () => {
  const { committer, manifestStore } = setup();
  const frames = [{ pageNumber: 1, dbSizeAfterCommit: 1 }];
  const result = await committer.commitWalDelta(Buffer.from('delta-1'), frames, PAGE_SIZE);
  assert.ok(result.segmentId);
  const { manifest } = await manifestStore.read();
  assert.equal(manifest.baseSegmentId, null);
  assert.deepEqual(manifest.walSegmentIds, [result.segmentId]);
  assert.equal(manifest.pageSize, PAGE_SIZE);
});

test('pageSize is carried forward unchanged on later commits', async () => {
  const { committer, manifestStore } = setup();
  await committer.commitWalDelta(Buffer.from('a'), [{ pageNumber: 1, dbSizeAfterCommit: 1 }], PAGE_SIZE);
  await committer.commitWalDelta(Buffer.from('b'), [{ pageNumber: 2, dbSizeAfterCommit: 2 }], PAGE_SIZE);
  const { manifest } = await manifestStore.read();
  assert.equal(manifest.pageSize, PAGE_SIZE);
});

test('segment meta records dbSizeAfterCommit from the last frame', async () => {
  const { committer, manifestStore, segmentStore } = setup();
  const frames = [
    { pageNumber: 1, dbSizeAfterCommit: 0 },
    { pageNumber: 2, dbSizeAfterCommit: 7 },
  ];
  const result = await committer.commitWalDelta(Buffer.from('delta'), frames, PAGE_SIZE);
  const seg = await segmentStore.getSegment(result.segmentId);
  assert.equal(seg.meta.dbSizeAfterCommit, 7);
  assert.deepEqual(seg.meta.writeSet, [1, 2]);
});

test('pageSize self-heals on the next commit if the read manifest is missing it (I-B)', async () => {
  const { committer, manifestStore, segmentStore } = setup();
  await committer.commitWalDelta(Buffer.from('a'), [{ pageNumber: 1, dbSizeAfterCommit: 1 }], PAGE_SIZE);

  // Simulate a manifest that lost its pageSize field (old-format manifest, or
  // an unrelated bug) — reading it back should not propagate `undefined`
  // forever; the next commit must fall back to its own passed-in pageSize.
  const brokenManifestStore = {
    async read() {
      const { manifest, etag } = await manifestStore.read();
      return { manifest: { ...manifest, pageSize: undefined }, etag };
    },
    write: manifestStore.write.bind(manifestStore),
  };
  const healingCommitter = createCommitter({ manifestStore: brokenManifestStore, segmentStore, sleep: async () => {} });
  await healingCommitter.commitWalDelta(Buffer.from('b'), [{ pageNumber: 2, dbSizeAfterCommit: 2 }], PAGE_SIZE);

  const { manifest } = await manifestStore.read();
  assert.equal(manifest.pageSize, PAGE_SIZE);
});

test('two non-overlapping commits both land (second rebases automatically)', async () => {
  const { committer, manifestStore } = setup();
  // Writer A reads manifest version 0, then commits touching page 1.
  const resultA = await committer.commitWalDelta(Buffer.from('a'), [{ pageNumber: 1, dbSizeAfterCommit: 1 }], PAGE_SIZE);
  // Writer B, unaware of A, also started from version 0 and commits touching page 2.
  // Simulate this by calling commitWalDelta again without B having "seen" A's write —
  // commitWalDelta always re-reads the manifest internally, so this models B racing in
  // right after A landed: B's local transaction was built against the pre-A base, but
  // since B's write-set (page 2) doesn't overlap A's (page 1), it must still land.
  const resultB = await committer.commitWalDelta(Buffer.from('b'), [{ pageNumber: 2, dbSizeAfterCommit: 2 }], PAGE_SIZE);
  assert.ok(resultB.segmentId);
  const { manifest } = await manifestStore.read();
  assert.deepEqual(manifest.walSegmentIds, [resultA.segmentId, resultB.segmentId]);
});

test('overlapping commit is reported as a required retry, not silently merged', async () => {
  const { committer, manifestStore, segmentStore } = setup();
  await committer.commitWalDelta(Buffer.from('a'), [{ pageNumber: 5, dbSizeAfterCommit: 5 }], PAGE_SIZE);
  // Force a stale read: manually give the committer an outdated manifest snapshot by
  // racing a manifest write in between read and write via a wrapped manifestStore.
  const staleManifestStore = {
    async read() {
      // Return the pre-A state even though the store already has A's commit —
      // this simulates writer B having snapshotted before A landed.
      return { manifest: { baseSegmentId: null, walSegmentIds: [], pageSize: PAGE_SIZE }, etag: null };
    },
    write: manifestStore.write.bind(manifestStore),
  };
  const staleCommitter = createCommitter({
    manifestStore: staleManifestStore,
    segmentStore,
    sleep: async () => {},
  });
  const result = await staleCommitter.commitWalDelta(Buffer.from('b'), [{ pageNumber: 5, dbSizeAfterCommit: 5 }], PAGE_SIZE);
  assert.deepEqual(result, { retryTransaction: true });
});

test('gives up after 10 attempts if every retry keeps conflicting', async () => {
  const { manifestStore, segmentStore } = setup();
  await manifestStore.write({ baseSegmentId: null, walSegmentIds: [], pageSize: PAGE_SIZE }, { expectedEtag: null });
  const alwaysStaleStore = {
    read: async () => ({ manifest: { baseSegmentId: null, walSegmentIds: [], pageSize: PAGE_SIZE }, etag: null }),
    write: async () => {
      // Every write conflicts because someone else always beats us with an overlapping page.
      const seg = await segmentStore.putSegment(Buffer.from('other'), { writeSet: [99], dbSizeAfterCommit: 99 });
      await manifestStore.write(
        {
          baseSegmentId: null,
          walSegmentIds: [...(await manifestStore.read()).manifest.walSegmentIds, seg],
          pageSize: PAGE_SIZE,
        },
        { expectedEtag: (await manifestStore.read()).etag }
      );
      const err = new Error('manifest changed since last read');
      err.name = 'ManifestConflictError';
      err.current = await manifestStore.read();
      throw err;
    },
  };
  const flakyCommitter = createCommitter({ manifestStore: alwaysStaleStore, segmentStore, sleep: async () => {} });
  await assert.rejects(
    () => flakyCommitter.commitWalDelta(Buffer.from('mine'), [{ pageNumber: 5, dbSizeAfterCommit: 5 }], PAGE_SIZE),
    /max retries/
  );
});
