async function assertOk(response) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ghost Admin API request failed: ${response.status} ${body}`);
  }
  return response;
}

function authHeaders(token, extra = {}) {
  return { Authorization: `Ghost ${token}`, ...extra };
}

const IMAGE_MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

function mimeTypeForFilename(filename) {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_MIME_TYPES[ext] ?? 'application/octet-stream';
}

export async function uploadImage(baseUrl, token, { buffer, filename }, fetchImpl = fetch) {
  const form = new FormData();
  // A real Ghost server rejects a file part with no (or the wrong)
  // Content-Type as 415 "Please select a valid image" -- Blob's type
  // defaults to empty unless given explicitly.
  form.append('file', new Blob([buffer], { type: mimeTypeForFilename(filename) }), filename);
  form.append('purpose', 'image');

  const response = await fetchImpl(`${baseUrl}/images/upload/`, {
    method: 'POST',
    headers: authHeaders(token),
    body: form,
  });
  await assertOk(response);
  const { images } = await response.json();
  return { url: images[0].url };
}

export async function createDraftPost(baseUrl, token, { title, featureImageUrl }, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/posts/`, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      posts: [{ title, status: 'draft', feature_image: featureImageUrl }],
    }),
  });
  await assertOk(response);
  const { posts } = await response.json();
  return { id: posts[0].id };
}

export async function getPost(baseUrl, token, id, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/posts/${id}/`, {
    headers: authHeaders(token),
  });
  await assertOk(response);
  const { posts } = await response.json();
  return posts[0];
}

export async function deletePost(baseUrl, token, id, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/posts/${id}/`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  await assertOk(response);
}

/**
 * Reads a resource's total count from the Admin API's pagination metadata.
 * `filter` is an optional Ghost NQL filter string (e.g.
 * `'status:published+type:post'`, `+` being NQL's AND) applied as-is via
 * the `filter` query param — pass nothing to get the resource's unfiltered
 * total.
 */
export async function getResourceTotal(baseUrl, token, resource, fetchImpl = fetch, filter) {
  const qs = new URLSearchParams({ limit: '1' });
  if (filter) qs.set('filter', filter);
  const response = await fetchImpl(`${baseUrl}/${resource}/?${qs.toString()}`, {
    headers: authHeaders(token),
  });
  await assertOk(response);
  const body = await response.json();
  const total = body?.meta?.pagination?.total;
  if (typeof total !== 'number') {
    throw new Error(`Ghost Admin API returned no pagination total for ${resource}`);
  }
  return total;
}

export async function listRecentPosts(baseUrl, token, limit, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${baseUrl}/posts/?limit=${limit}&formats=html&order=updated_at%20desc`,
    { headers: authHeaders(token) }
  );
  await assertOk(response);
  const { posts } = await response.json();
  return posts;
}
