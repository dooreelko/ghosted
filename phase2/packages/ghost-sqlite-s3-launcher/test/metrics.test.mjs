import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetricsPublisher } from '../src/metrics.mjs';

test('publish sends a PutMetricData request with the given name, value, and unit', async () => {
  const calls = [];
  const fakeClient = {
    async send(command) {
      calls.push(command.input);
      return {};
    },
  };
  const metrics = createMetricsPublisher({ client: fakeClient });

  await metrics.publish('OrphanedSegmentCount', 3);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].Namespace, 'GhostPhase2/SqliteS3');
  assert.deepEqual(calls[0].MetricData, [{ MetricName: 'OrphanedSegmentCount', Value: 3, Unit: 'Count' }]);
});

test('publish defaults to Count but accepts an explicit unit', async () => {
  const calls = [];
  const fakeClient = { async send(command) { calls.push(command.input); return {}; } };
  const metrics = createMetricsPublisher({ client: fakeClient });

  await metrics.publish('RestoreDurationMs', 1234, 'Milliseconds');

  assert.deepEqual(calls[0].MetricData, [{ MetricName: 'RestoreDurationMs', Value: 1234, Unit: 'Milliseconds' }]);
});

test('publish swallows a CloudWatch failure rather than throwing (non-fatal)', async () => {
  const fakeClient = {
    async send() {
      throw new Error('boom: simulated CloudWatch outage');
    },
  };
  const metrics = createMetricsPublisher({ client: fakeClient });

  await metrics.publish('RestoreRetryCount', 1); // must not throw/reject
});
