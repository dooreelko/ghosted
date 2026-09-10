import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const NAMESPACE = 'GhostPhase2/SqliteS3';

export function createMetricsPublisher({ client = new CloudWatchClient({}) } = {}) {
  return {
    async publish(metricName, value, unit = 'Count') {
      try {
        await client.send(new PutMetricDataCommand({
          Namespace: NAMESPACE,
          MetricData: [{ MetricName: metricName, Value: value, Unit: unit }],
        }));
      } catch (err) {
        // A monitoring failure must never affect Ghost's boot -- log and move on.
        console.error(`[ghost-sqlite-s3-launcher] failed to publish metric ${metricName}:`, err.message);
      }
    },
  };
}
