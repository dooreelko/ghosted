import { S3Client } from '@aws-sdk/client-s3';
import { createS3ObjectStore } from '@ghost-phase3/sqlite-s3';
import { createCheckpointHandler } from './checkpoint-app.mjs';

export const handler = createCheckpointHandler({
  objectStore: createS3ObjectStore({ bucket: process.env.STORE_BUCKET, client: new S3Client({ region: process.env.AWS_REGION }) }),
});
