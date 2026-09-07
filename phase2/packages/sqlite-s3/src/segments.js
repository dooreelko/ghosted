import { randomUUID } from 'node:crypto';
import { pack, unpack } from 'msgpackr';

export function createSegmentStore(store) {
  return {
    async putSegment(bytes, meta = {}) {
      const id = randomUUID();
      const encoded = pack({ meta, bytes });
      await store.put(`segments/${id}.seg`, encoded, { ifNoneMatch: true });
      return id;
    },
    async getSegment(id) {
      const { bytes: encoded } = await store.get(`segments/${id}.seg`);
      const { meta, bytes } = unpack(encoded);
      return { meta, bytes };
    },
  };
}
