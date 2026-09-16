export function findPreviousTag(deploymentsResponse, containerName = 'ghost') {
  const sorted = [...(deploymentsResponse.deployments ?? [])].sort((a, b) => b.version - a.version);
  if (sorted.length < 2) return null;
  // sorted[0] is the deployment being rolled back FROM (the one that just
  // failed verification and triggered this call) -- skip it regardless of
  // its own state. Among the rest, skip any that never actually went
  // healthy (FAILED): a prior verification/boot failure sitting in the
  // history is not a safe rollback target, even if it's the next-highest
  // version number. Confirmed as a real incident, 2026-09-16: taking
  // sorted[1] unconditionally picked a FAILED deployment's tag (an earlier
  // broken build) instead of the last deployment that had actually served
  // traffic, and the "rollback" just reproduced the outage it was
  // supposed to fix.
  const previous = sorted.slice(1).find((d) => d.state !== 'FAILED');
  if (!previous) return null;
  const image = previous.containers[containerName].image;
  return image.slice(image.lastIndexOf(':') + 1);
}
