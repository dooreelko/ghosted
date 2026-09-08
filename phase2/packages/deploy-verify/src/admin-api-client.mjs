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

export async function uploadImage(baseUrl, token, { buffer, filename }, fetchImpl = fetch) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
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
