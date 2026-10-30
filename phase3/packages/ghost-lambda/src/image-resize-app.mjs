// Size-variant fallback: the image behavior falls over here when a variant is
// missing from the content bucket. Resizes the original, stores the variant at
// the requested key and returns it. Not Ghost-backed: it needs only the image
// library and the list of allowed sizes.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SIZE_PATH = /^\/(.*?)\/content\/images\/size\/([^/]+)(?:\/format\/([a-z0-9]+))?\/(.+)$/;
const RESIZABLE = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);
const FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'gif']);
const CONTENT_TYPES = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
export const MAX_INLINE_BYTES = 5_500_000; // an HTTP API response tops out at 6 MB

// Ghost's own sizes (config overrides) plus every shipped theme's image_sizes.
const GHOST_SIZES = {
  w600: { width: 600 }, w1000: { width: 1000 }, w1600: { width: 1600 }, w2400: { width: 2400 },
  icon: { width: 256, height: 256 }, 'signup-form-icon': { width: 192, height: 192 }, 'email-cta-card': { width: 64, height: 64 },
  'email-header-image': { width: 1200 }, 'email-latest-posts-image': { width: 200, height: 200 },
  'email-latest-posts-image-mobile': { width: 1200, height: 960 }, 'social-image': { width: 1200 },
};

export function allowedDimensions(themesDir) {
  const sizes = { ...GHOST_SIZES };
  try {
    for (const t of fs.readdirSync(themesDir)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(themesDir, t, 'package.json'), 'utf8')).config?.image_sizes ?? {};
        Object.assign(sizes, cfg);
      } catch {}
    }
  } catch {}
  const dims = {};
  for (const { width, height } of Object.values(sizes)) {
    const key = (width ? `w${width}` : '') + (height ? `h${height}` : '');
    dims[key] ??= { width, height };
  }
  return dims;
}

// Build one size variant. Returns { kind: 'ok', bytes, contentType } | { kind: 'original' } (not
// resizable or unknown size: serve the original) | { kind: 'missing' } (no original).
export async function buildVariant({ store, dimensions, rawPath }) {
  const m = SIZE_PATH.exec(rawPath);
  if (!m) return { kind: 'missing' };
  const [, base, dim, format, rest] = m;
  const ext = path.extname(rest).toLowerCase();
  const wanted = dimensions[dim];
  if (!wanted || !RESIZABLE.has(ext) || (format && !FORMATS.has(format))) return { kind: 'original', original: `/${base}/content/images/${rest}` };
  const bytes = await store.get(`${base}/content/images/${rest}`.replace(/^\/+/, ''));
  if (!bytes || !bytes.length) return { kind: 'missing' };
  try {
    const img = sharp(bytes, { animated: ext === '.gif' || ext === '.webp' })
      .rotate()
      .resize({ width: wanted.width, height: wanted.height, withoutEnlargement: true });
    const out = await (format ? img.toFormat(format) : img).toBuffer();
    return { kind: 'ok', bytes: out, contentType: CONTENT_TYPES[format ?? ext.slice(1)] ?? 'application/octet-stream' };
  } catch {
    return { kind: 'original', original: `/${base}/content/images/${rest}` };
  }
}

export function createImageResizeHandler({ store, dimensions, cacheControl = 'public, max-age=31536000, immutable' }) {
  const redirect = (location) => ({ statusCode: 302, headers: { location, 'cache-control': 'no-store' }, body: '' });
  return async (event) => {
    if (!SIZE_PATH.test(event.rawPath)) return { statusCode: 404, body: 'not found' };
    const v = await buildVariant({ store, dimensions, rawPath: event.rawPath });
    if (v.kind === 'original') return redirect(v.original);
    if (v.kind === 'missing') return { statusCode: 404, body: 'not found' };
    await store.put(event.rawPath.slice(1), v.bytes, { contentType: v.contentType, cacheControl });
    if (v.bytes.length > MAX_INLINE_BYTES) return redirect(event.rawPath);
    return { statusCode: 200, headers: { 'content-type': v.contentType, 'cache-control': cacheControl }, body: v.bytes.toString('base64'), isBase64Encoded: true };
  };
}
