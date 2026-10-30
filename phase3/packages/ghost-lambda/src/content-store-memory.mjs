// In-memory content store with the same shape as the S3 one, for local runs and tests.
export function createMemoryContentStore() {
  const objects = new Map();
  return {
    objects,
    async put(key, bytes, meta = {}) { objects.set(key, { bytes: Buffer.from(bytes), ...meta }); },
    async get(key) { return objects.get(key)?.bytes ?? null; },
    async exists(key) { return objects.has(key); },
    async delete(key) { objects.delete(key); },
  };
}
