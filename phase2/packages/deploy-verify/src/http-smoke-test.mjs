export async function checkUrls(urls, fetchImpl = fetch) {
  const results = [];
  for (const url of urls) {
    try {
      const response = await fetchImpl(url);
      results.push({ url, status: response.status });
    } catch (err) {
      results.push({ url, error: err.message });
    }
  }
  const ok = results.every((r) => r.status === 200);
  return { ok, results };
}
