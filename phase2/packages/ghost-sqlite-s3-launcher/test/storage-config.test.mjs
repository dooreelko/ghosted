import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildS3StorageConfig } from '../src/storage-config.mjs';

test('buildS3StorageConfig produces Ghost S3Storage adapter config', () => {
  const result = buildS3StorageConfig({
    bucket: 'ghost-phase2-data',
    region: 'us-east-1',
    cdnUrl: 'https://ghost-phase2-data.s3.us-east-1.amazonaws.com',
  });

  assert.deepEqual(result, {
    bucket: 'ghost-phase2-data',
    region: 'us-east-1',
    staticFileURLPrefix: 'content/images',
    cdnUrl: 'https://ghost-phase2-data.s3.us-east-1.amazonaws.com',
    multipartUploadThresholdBytes: 25 * 1024 * 1024,
    multipartChunkSizeBytes: 5 * 1024 * 1024,
  });
});
