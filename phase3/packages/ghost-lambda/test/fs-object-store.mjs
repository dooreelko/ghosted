// Directory-backed object store with S3's conditional-write semantics, so
// several local processes can share one store in tests.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const err = (code, message) => Object.assign(new Error(message), { code });

export function createFsObjectStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (key) => path.join(dir, encodeURIComponent(key));
  const lockDir = path.join(dir, '.lock');
  const etagOf = (bytes) => crypto.createHash('sha1').update(bytes).digest('hex');
  async function locked(fn) {
    for (;;) {
      try { fs.mkdirSync(lockDir); break; } catch { await new Promise((r) => setTimeout(r, 5)); }
    }
    try { return await fn(); } finally { fs.rmdirSync(lockDir); }
  }
  return {
    async get(key) {
      let bytes;
      try { bytes = fs.readFileSync(file(key)); } catch { throw err('NotFound', `no object at ${key}`); }
      return { bytes, etag: etagOf(bytes) };
    },
    put(key, bytes, opts = {}) {
      return locked(() => {
        let existing = null;
        try { existing = fs.readFileSync(file(key)); } catch {}
        if (opts.ifNoneMatch && existing) throw err('PreconditionFailed', `${key} already exists`);
        if (opts.ifMatch !== undefined && opts.ifMatch !== null && (!existing || etagOf(existing) !== opts.ifMatch)) {
          throw err('PreconditionFailed', `${key} etag mismatch`);
        }
        const buf = Buffer.from(bytes);
        fs.writeFileSync(`${file(key)}.tmp`, buf);
        fs.renameSync(`${file(key)}.tmp`, file(key));
        return { etag: etagOf(buf) };
      });
    },
    async delete(key) { fs.rmSync(file(key), { force: true }); },
    async list(prefix) { return (await this.listWithMetadata(prefix)).map((e) => e.key); },
    async listWithMetadata(prefix) {
      return fs.readdirSync(dir)
        .filter((n) => !n.startsWith('.') && !n.endsWith('.tmp'))
        .map((n) => ({ key: decodeURIComponent(n), lastModified: fs.statSync(path.join(dir, n)).mtimeMs }))
        .filter((e) => e.key.startsWith(prefix));
    },
  };
}
