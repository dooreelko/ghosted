import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
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
        if (err.$metadata?.httpStatusCode === 412) {
          throw makeError('PreconditionFailed', `${key} precondition failed`);
        }
        throw err;
      }
    },
  };
}
