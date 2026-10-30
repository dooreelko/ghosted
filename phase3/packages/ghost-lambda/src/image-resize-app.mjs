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
const MAX_INLINE_BYTES = 5_500_000; // an HTTP API response tops out at 6 MB

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

export function createImageResizeHandler({ store, dimensions, cacheControl = 'public, max-age=31536000, immutable' }) {
  const redirect = (location) => ({ statusCode: 302, headers: { location, 'cache-control': 'no-store' }, body: '' });
  return async (event) => {
    const m = SIZE_PATH.exec(event.rawPath);
    if (!m) return { statusCode: 404, body: 'not found' };
    const [, base, dim, format, rest] = m;
    const original = `/${base}/content/images/${rest}`;
    const ext = path.extname(rest).toLowerCase();
    const wanted = dimensions[dim];
    if (!wanted || !RESIZABLE.has(ext) || (format && !FORMATS.has(format))) return redirect(original);

    const bytes = await store.get(original.slice(1));
    if (!bytes || !bytes.length) return { statusCode: 404, body: 'not found' };

    let out;
    try {
      const img = sharp(bytes, { animated: ext === '.gif' || ext === '.webp' })
        .rotate()
        .resize({ width: wanted.width, height: wanted.height, withoutEnlargement: true });
      out = await (format ? img.toFormat(format) : img).toBuffer();
    } catch {
      return redirect(original);
    }
    const contentType = CONTENT_TYPES[format ?? ext.slice(1)] ?? 'application/octet-stream';
    await store.put(event.rawPath.slice(1), out, { contentType, cacheControl });
    if (out.length > MAX_INLINE_BYTES) return redirect(event.rawPath);
    return { statusCode: 200, headers: { 'content-type': contentType, 'cache-control': cacheControl }, body: out.toString('base64'), isBase64Encoded: true };
  };
}
