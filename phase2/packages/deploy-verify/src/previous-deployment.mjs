export function findPreviousTag(deploymentsResponse, containerName = 'ghost') {
  const sorted = [...(deploymentsResponse.deployments ?? [])].sort((a, b) => b.version - a.version);
  if (sorted.length < 2) return null;
  const image = sorted[1].containers[containerName].image;
  return image.slice(image.lastIndexOf(':') + 1);
}
