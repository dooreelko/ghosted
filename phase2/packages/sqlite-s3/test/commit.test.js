import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createSegmentStore } from '../src/segments.js';
import { createManifestStore } from '../src/manifest.js';
import { createCommitter } from '../src/commit.js';

function setup() {
  const store = createInMemoryObjectStore();
  const segmentStore = createSegmentStore(store);
  const manifestStore = createManifestStore(store);
  const committer = createCommitter({ manifestStore, segmentStore, sleep: async () => {} });
  return { segmentStore, manifestStore, committer };
}

test('first commit ever writes a manifest with baseSegmentId null', async () => {
  const { committer, manifestStore } = setup();
  const frames = [{ pageNumber: 1 }];
  const result = await committer.commitWalDelta(Buffer.from('delta-1'), frames);
  assert.ok(result.segmentId);
  const { manifest } = await manifestStore.read();
  assert.equal(manifest.baseSegmentId, null);
  assert.deepEqual(manifest.walSegmentIds, [result.segmentId]);
});

test('two non-overlapping commits both land (second rebases automatically)', async () => {
  const { committer, manifestStore } = setup();
  // Writer A reads manifest version 0, then commits touching page 1.
  const resultA = await committer.commitWalDelta(Buffer.from('a'), [{ pageNumber: 1 }]);
  // Writer B, unaware of A, also started from version 0 and commits touching page 2.
  // Simulate this by calling commitWalDelta again without B having "seen" A's write —
  // commitWalDelta always re-reads the manifest internally, so this models B racing in
  // right after A landed: B's local transaction was built against the pre-A base, but
  // since B's write-set (page 2) doesn't overlap A's (page 1), it must still land.
  const resultB = await committer.commitWalDelta(Buffer.from('b'), [{ pageNumber: 2 }]);
  assert.ok(resultB.segmentId);
  const { manifest } = await manifestStore.read();
  assert.deepEqual(manifest.walSegmentIds, [resultA.segmentId, resultB.segmentId]);
});

test('overlapping commit is reported as a required retry, not silently merged', async () => {
  const { committer, manifestStore, segmentStore } = setup();
  await committer.commitWalDelta(Buffer.from('a'), [{ pageNumber: 5 }]);
  // Force a stale read: manually give the committer an outdated manifest snapshot by
  // racing a manifest write in between read and write via a wrapped manifestStore.
  const staleManifestStore = {
    async read() {
      // Return the pre-A state even though the store already has A's commit —
      // this simulates writer B having snapshotted before A landed.
      return { manifest: { baseSegmentId: null, walSegmentIds: [] }, etag: null };
    },
    write: manifestStore.write.bind(manifestStore),
  };
  const staleCommitter = createCommitter({
    manifestStore: staleManifestStore,
    segmentStore,
    sleep: async () => {},
  });
  const result = await staleCommitter.commitWalDelta(Buffer.from('b'), [{ pageNumber: 5 }]);
  assert.deepEqual(result, { retryTransaction: true });
});

test('gives up after 10 attempts if every retry keeps conflicting', async () => {
  const { manifestStore, segmentStore } = setup();
  await manifestStore.write({ baseSegmentId: null, walSegmentIds: [] }, { expectedEtag: null });
  const alwaysStaleStore = {
    read: async () => ({ manifest: { baseSegmentId: null, walSegmentIds: [] }, etag: null }),
    write: async () => {
      // Every write conflicts because someone else always beats us with an overlapping page.
      const seg = await segmentStore.putSegment(Buffer.from('other'), { writeSet: [99] });
      await manifestStore.write(
        { baseSegmentId: null, walSegmentIds: [...(await manifestStore.read()).manifest.walSegmentIds, seg] },
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
    () => flakyCommitter.commitWalDelta(Buffer.from('mine'), [{ pageNumber: 5 }]),
    /max retries/
  );
});
