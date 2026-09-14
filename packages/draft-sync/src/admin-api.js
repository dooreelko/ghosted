import GhostAdminAPI from '@tryghost/admin-api';

export function createAdminApi(env = process.env) {
  const url = env.GHOST_ADMIN_API_URL;
  const key = env.GHOST_ADMIN_API_KEY;
  if (!url) {
    throw new Error('GHOST_ADMIN_API_URL is not set');
  }
  if (!key) {
    throw new Error('GHOST_ADMIN_API_KEY is not set');
  }
  return new GhostAdminAPI({ url, key, version: true });
}
