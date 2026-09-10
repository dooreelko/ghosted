import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildS3StorageConfig } from '../src/storage-config.mjs';

test('buildS3StorageConfig derives the cdn url and key prefix from a subpath GHOST_URL', () => {
  const result = buildS3StorageConfig({
    bucket: 'ghost-phase2-data',
    region: 'us-east-1',
    ghostUrl: 'https://example.com/blog',
  });

  assert.deepEqual(result, {
    bucket: 'ghost-phase2-data',
    region: 'us-east-1',
    staticFileURLPrefix: 'blog/content/images',
    cdnUrl: 'https://example.com',
    multipartUploadThresholdBytes: 25 * 1024 * 1024,
    multipartChunkSizeBytes: 5 * 1024 * 1024,
  });
});

test('buildS3StorageConfig tolerates a trailing slash on GHOST_URL', () => {
  const result = buildS3StorageConfig({
    bucket: 'b',
    region: 'us-east-1',
    ghostUrl: 'https://example.com/blog/',
  });

  assert.equal(result.staticFileURLPrefix, 'blog/content/images');
  assert.equal(result.cdnUrl, 'https://example.com');
});

test('buildS3StorageConfig handles a root-hosted GHOST_URL', () => {
  const result = buildS3StorageConfig({
    bucket: 'b',
    region: 'us-east-1',
    ghostUrl: 'https://example.com',
  });

  assert.equal(result.staticFileURLPrefix, 'content/images');
  assert.equal(result.cdnUrl, 'https://example.com');
});

test('buildS3StorageConfig rejects a GHOST_URL that is not a valid absolute URL', () => {
  assert.throws(
    () => buildS3StorageConfig({ bucket: 'b', region: 'us-east-1', ghostUrl: 'not-a-url' }),
    /ghostUrl must be an absolute URL/
  );
});
