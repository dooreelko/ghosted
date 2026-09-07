export function createCheckpointPolicy({ maxWalBytes, maxIntervalMs, now = () => Date.now() }) {
  let bytesSinceCheckpoint = 0;
  let lastCheckpointAt = now();
  let dirty = false;

  return {
    recordSegment(byteLength) {
      bytesSinceCheckpoint += byteLength;
      dirty = true;
    },
    shouldCheckpoint() {
      if (bytesSinceCheckpoint >= maxWalBytes) return true;
      if (dirty && now() - lastCheckpointAt >= maxIntervalMs) return true;
      return false;
    },
    recordCheckpoint() {
      bytesSinceCheckpoint = 0;
      lastCheckpointAt = now();
      dirty = false;
    },
  };
}
