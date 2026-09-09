/**
 * Ghost's S3Storage adapter config shape (config.set('storage:S3Storage', ...),
 * with config.set('storage:active', 'S3Storage') set alongside it — see
 * preload.mjs). No accessKeyId/secretAccessKey: S3Storage falls back to the
 * ambient credential chain, which the credential_process profile (see
 * aws-credentials.mjs) already points at the assumed app-runtime role.
 *
 * Key layout: S3Storage.buildKey joins staticFileURLPrefix with the image's
 * relative path and returns `${cdnUrl}/${key}`. Both are derived from
 * GHOST_URL so that the public path and the S3 key are identical modulo the
 * leading slash — CloudFront's OriginPath prepends rather than strips, so
 * anything else would need a URI-rewriting CloudFront Function. With
 * GHOST_URL=https://example.com/blog an image is served from
 * https://example.com/blog/content/images/... and stored at the key
 * blog/content/images/... .
 */
export function buildS3StorageConfig({ bucket, region, ghostUrl }) {
  let url;
  try {
    url = new URL(ghostUrl);
  } catch {
    throw new Error(`ghostUrl must be an absolute URL, got: ${ghostUrl}`);
  }

  const basePath = url.pathname.replace(/^\/+|\/+$/g, '');
  const staticFileURLPrefix = basePath ? `${basePath}/content/images` : 'content/images';

  return {
    bucket,
    region,
    staticFileURLPrefix,
    cdnUrl: url.origin,
    multipartUploadThresholdBytes: 25 * 1024 * 1024,
    multipartChunkSizeBytes: 5 * 1024 * 1024,
  };
}
