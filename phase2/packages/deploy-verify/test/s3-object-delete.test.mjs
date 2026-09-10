import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteS3Object } from '../src/s3-object-delete.mjs';

test('deleteS3Object sends a DeleteObject command for the URL-derived key', async () => {
  let sentCommand;
  const s3Client = {
    send: async (command) => {
      sentCommand = command;
      return {};
    },
  };

  await deleteS3Object(
    'ghost-phase2-data-699571927575',
    'https://ghost-phase2-data-699571927575.s3.amazonaws.com/2026/09/test-pixel.png',
    s3Client,
  );

  assert.equal(sentCommand.input.Bucket, 'ghost-phase2-data-699571927575');
  assert.equal(sentCommand.input.Key, '2026/09/test-pixel.png');
});

test('deleteS3Object strips a leading slash from a path-style URL key', async () => {
  let sentCommand;
  const s3Client = { send: async (command) => { sentCommand = command; return {}; } };

  await deleteS3Object(
    'ghost-phase2-data-699571927575',
    'https://s3.amazonaws.com/ghost-phase2-data-699571927575/2026/09/test-pixel.png',
    s3Client,
  );

  assert.equal(sentCommand.input.Key, '2026/09/test-pixel.png');
});
