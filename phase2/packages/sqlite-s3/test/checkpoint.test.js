import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpointPolicy } from '../src/checkpoint.js';

test('no checkpoint needed with no activity', () => {
  const policy = createCheckpointPolicy({ maxWalBytes: 1000, maxIntervalMs: 60_000 });
  assert.equal(policy.shouldCheckpoint(), false);
});

test('size-triggered: checkpoint once accumulated bytes cross the threshold', () => {
  const policy = createCheckpointPolicy({ maxWalBytes: 100, maxIntervalMs: 60_000 });
  policy.recordSegment(60);
  assert.equal(policy.shouldCheckpoint(), false);
  policy.recordSegment(50);
  assert.equal(policy.shouldCheckpoint(), true);
});

test('recordCheckpoint resets the size counter', () => {
  const policy = createCheckpointPolicy({ maxWalBytes: 100, maxIntervalMs: 60_000 });
  policy.recordSegment(150);
  assert.equal(policy.shouldCheckpoint(), true);
  policy.recordCheckpoint();
  assert.equal(policy.shouldCheckpoint(), false);
});

test('time-triggered: checkpoint after the interval, but only if something changed', () => {
  let clock = 0;
  const policy = createCheckpointPolicy({ maxWalBytes: 1_000_000, maxIntervalMs: 1000, now: () => clock });
  clock = 2000;
  assert.equal(policy.shouldCheckpoint(), false, 'idle period must not trigger a no-op checkpoint');
  policy.recordSegment(1);
  assert.equal(policy.shouldCheckpoint(), true);
});

test('time-triggered checkpoint is not re-armed until the interval passes again', () => {
  let clock = 0;
  const policy = createCheckpointPolicy({ maxWalBytes: 1_000_000, maxIntervalMs: 1000, now: () => clock });
  policy.recordSegment(1);
  clock = 1500;
  assert.equal(policy.shouldCheckpoint(), true);
  policy.recordCheckpoint();
  policy.recordSegment(1);
  clock = 1600;
  assert.equal(policy.shouldCheckpoint(), false);
  clock = 2600;
  assert.equal(policy.shouldCheckpoint(), true);
});
