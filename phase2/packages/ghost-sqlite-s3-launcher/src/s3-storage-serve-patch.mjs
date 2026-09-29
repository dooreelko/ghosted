/**
 * Ghost's S3Storage.serve() answers every request with a 301 to
 * `${cdnUrl}/${key}`. Here cdnUrl is the site's own public origin (see
 * storage-config.mjs), so that 301 points at the exact URL just requested.
 * The app is only reached for images when CloudFront's S3 origin 403s on a
 * size variant that doesn't exist yet (f34h6): Ghost's image-size middleware
 * generates and saves the variant, then hands off to serve(), and the
 * cacheable 301-to-self turns into a redirect loop at CloudFront and in the
 * browser (a1jxt).
 *
 * Replacement serve(): a size-variant request gets an uncacheable 302 to the
 * full-size original -- a different URL, so no loop is possible even though
 * CloudFront's image cache policy keeps any response for at least its 1s
 * MinTTL. The next request for the variant finds it in S3. Anything else
 * falls through (next()) to Ghost's own 404 handling instead of redirecting
 * to itself.
 */

// Mirrors Ghost's handle-image-sizes.js: /size/<dimension>/ optionally
// followed by /format/<format>/, at the start of the mount-relative path.
const SIZE_VARIANT_REGEX = /^\/size\/([^/]+)\/(?:format\/([^./]+)\/)?/;

export function originalImageUrl(reqPath, originalUrl) {
  const match = reqPath.match(SIZE_VARIANT_REGEX);
  if (!match) {
    return null;
  }
  const [, dimension, format] = match;
  let url = originalUrl.replace(`/size/${dimension}`, '');
  if (format) {
    url = url.replace(`/format/${format}`, '');
  }
  // Strip multiple leading slashes to prevent protocol-relative redirects.
  return url.replace(/^\/+/, '/');
}

export function serveViaOriginal(req, res, next) {
  const url = originalImageUrl(req.path, req.originalUrl);
  if (!url) {
    return next();
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.redirect(302, url);
}

export function patchS3StorageServe(S3Storage) {
  if (typeof S3Storage?.prototype?.serve !== 'function') {
    throw new Error('S3Storage.prototype.serve not found');
  }
  S3Storage.prototype.serve = function serve() {
    return serveViaOriginal;
  };
}
