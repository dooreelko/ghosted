import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createInMemoryObjectStore() {
  const objects = new Map(); // key -> { bytes, etag }
  return {
    async get(key) {
      const obj = objects.get(key);
      if (!obj) throw makeError('NotFound', `no object at ${key}`);
      return { bytes: obj.bytes, etag: obj.etag };
    },
    async put(key, bytes, opts = {}) {
      const existing = objects.get(key);
      if (opts.ifNoneMatch && existing) {
        throw makeError('PreconditionFailed', `${key} already exists`);
      }
      if (opts.ifMatch !== undefined && opts.ifMatch !== null) {
        if (!existing || existing.etag !== opts.ifMatch) {
          throw makeError('PreconditionFailed', `${key} etag mismatch`);
        }
      }
      const etag = randomUUID();
      objects.set(key, { bytes: Buffer.from(bytes), etag });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

export function createS3ObjectStore({ bucket, client = new S3Client({}) }) {
  return {
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = [];
        for await (const chunk of res.Body) chunks.push(chunk);
        return { bytes: Buffer.concat(chunks), etag: res.ETag };
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
          throw makeError('NotFound', `no object at ${key}`);
        }
        throw err;
      }
    },
    async put(key, bytes, opts = {}) {
      const input = { Bucket: bucket, Key: key, Body: bytes };
      if (opts.ifNoneMatch) input.IfNoneMatch = '*';
      if (opts.ifMatch !== undefined && opts.ifMatch !== null) input.IfMatch = opts.ifMatch;
      try {
        const res = await client.send(new PutObjectCommand(input));
        return { etag: res.ETag };
      } catch (err) {
        // 412 Precondition Failed is S3's standard "someone else won the
        // race" response for a failed If-Match/If-None-Match. S3 can also
        // return 409 with error name ConditionalRequestConflict for a
        // conditional write racing another conditional write to the same
        // key — same "retry, you lost the race" condition in practice, so
        // map it the same way. A plain 409-status check (without also
        // requiring the name) is intentionally broad here: 409 is less
        // universally a precondition-failure signal than 412 is, but for
        // this client every write to a given key is always conditional, so
        // there's no other 409 case to conflate it with.
        if (err.$metadata?.httpStatusCode === 412 || err.$metadata?.httpStatusCode === 409) {
          throw makeError('PreconditionFailed', `${key} precondition failed`);
        }
        throw err;
      }
    },
    async delete(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return;
        throw err;
      }
    },
    async list(prefix) {
      const keys = [];
      let continuationToken;
      do {
        const res = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }));
        for (const obj of res.Contents ?? []) keys.push(obj.Key);
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },
  };
}
