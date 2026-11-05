/**
 * Ghost's S3Storage adapter settings. Images live in the content bucket at the
 * key equal to their public path (blog/content/images/...), so that adapter
 * reads them for the image dimensions the pages embed.
 */
export function buildS3StorageConfig({ bucket, region, ghostUrl }) {
  const url = new URL(ghostUrl);
  const basePath = url.pathname.replace(/^\/+|\/+$/g, '');
  return {
    bucket,
    region,
    staticFileURLPrefix: basePath ? `${basePath}/content/images` : 'content/images',
    cdnUrl: url.origin,
    multipartUploadThresholdBytes: 25 * 1024 * 1024,
    multipartChunkSizeBytes: 5 * 1024 * 1024,
  };
}
