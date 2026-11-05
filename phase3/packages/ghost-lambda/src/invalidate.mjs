// One wildcard invalidation over the blog path, as the last step of a run. Off
// unless INVALIDATE=1 (it is switched on together with the edge, never before).
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';

export function createInvalidator({ distributionId, enabled, basePath, client }) {
  return async function invalidate() {
    if (!enabled || !distributionId) return { invalidated: false };
    const c = client ?? new CloudFrontClient({});
    await c.send(new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: { CallerReference: String(Date.now()), Paths: { Quantity: 1, Items: [`${basePath}/*`] } },
    }));
    return { invalidated: true };
  };
}
