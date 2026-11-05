const MANIFEST_KEY = 'root.json';

export class ManifestConflictError extends Error {
  constructor(current) {
    super('manifest changed since last read');
    this.name = 'ManifestConflictError';
    this.current = current;
  }
}

export function createManifestStore(store) {
  async function read() {
    try {
      const { bytes, etag } = await store.get(MANIFEST_KEY);
      return { manifest: JSON.parse(bytes.toString('utf8')), etag };
    } catch (err) {
      if (err.code === 'NotFound') {
        return { manifest: null, etag: null };
      }
      throw err;
    }
  }

  return {
    read,
    async write(manifest, { expectedEtag }) {
      const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
      try {
        const { etag } = await store.put(MANIFEST_KEY, bytes, {
          ifMatch: expectedEtag ?? undefined,
          ifNoneMatch: expectedEtag === null,
        });
        return { etag };
      } catch (err) {
        if (err.code === 'PreconditionFailed') {
          const current = await read();
          throw new ManifestConflictError(current);
        }
        throw err;
      }
    },
  };
}
