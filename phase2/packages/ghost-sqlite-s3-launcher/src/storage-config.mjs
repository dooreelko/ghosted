/**
 * Ghost's S3Storage adapter config shape (config.set('storage:S3Storage', ...),
 * with config.set('storage:active', 'S3Storage') set alongside it — see
 * preload.mjs). No accessKeyId/secretAccessKey: S3Storage falls back to the
 * ambient credential chain, which the credential_process profile (see
 * aws-credentials.mjs) already points at the assumed app-runtime role.
 *
 * cdnUrl points at the bucket directly — nothing fronts it publicly yet (no
 * CDN; that's moth i8hlt's cutover work). Uploads still work and are recorded
 * correctly; public image URLs won't resolve until then.
 */
export function buildS3StorageConfig({ bucket, region, cdnUrl }) {
  return {
    bucket,
    region,
    staticFileURLPrefix: 'content/images',
    cdnUrl,
    multipartUploadThresholdBytes: 25 * 1024 * 1024,
    multipartChunkSizeBytes: 5 * 1024 * 1024,
  };
}
