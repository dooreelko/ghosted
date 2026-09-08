import { Before, After, setDefaultTimeout } from '@cucumber/cucumber';

// Real S3 round-trips (manifest reads/writes, segment puts) across many
// transactions, with real optimistic-concurrency retries and full-jitter
// backoff on real contention, comfortably exceed Cucumber's 5s default.
setDefaultTimeout(60_000);
import {
  CreateBucketCommand,
  PutBucketTaggingCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';

// Real AWS calls, no mocking: a missing/invalid credential chain makes
// CreateBucketCommand reject, and Cucumber reports that as a failed
// hook — the suite fails loudly rather than silently skipping, per
// this suite's whole purpose (prove the real thing works end to end).
Before(async function () {
  this.bucketName = `sqlite-s3-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const createParams = { Bucket: this.bucketName };
  if (this.region !== 'us-east-1') {
    createParams.CreateBucketConfiguration = { LocationConstraint: this.region };
  }
  await this.s3Client.send(new CreateBucketCommand(createParams));

  await this.s3Client.send(
    new PutBucketTaggingCommand({
      Bucket: this.bucketName,
      Tagging: {
        TagSet: [
          { Key: 'purpose', Value: 'sqlite-s3-e2e-test' },
          { Key: 'throwaway', Value: 'true' },
        ],
      },
    })
  );
});

After(async function () {
  // Always destroy every Knex instance a step created, even if an
  // assertion above failed — otherwise a failed scenario can leave
  // open pooled connections/file handles behind.
  await Promise.all(
    this.knexInstances.map((knex) => knex.destroy().catch(() => {}))
  );

  if (!this.bucketName) return;

  // Empty the bucket (S3 refuses to delete a non-empty bucket), then
  // delete it. Best-effort: log and move on rather than failing the
  // whole run over cleanup, since the actual test assertions already
  // ran by this point.
  try {
    let continuationToken;
    do {
      const listed = await this.s3Client.send(
        new ListObjectsV2Command({ Bucket: this.bucketName, ContinuationToken: continuationToken })
      );
      const objects = listed.Contents ?? [];
      if (objects.length > 0) {
        await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucketName,
            Delete: { Objects: objects.map((o) => ({ Key: o.Key })) },
          })
        );
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);

    await this.s3Client.send(new DeleteBucketCommand({ Bucket: this.bucketName }));
  } catch (err) {
    console.error(`sqlite-s3 e2e: failed to clean up bucket ${this.bucketName} (leaked, delete manually):`, err);
  }
});
