/**
 * End-to-end mail smoke test: requests a real magic-link signin email for
 * a known member, exercising the full Ghost mail path (SMTP auth, envelope
 * From) that a plain HTTP/Admin-API check can't reach. Only confirms the
 * send was accepted by Ghost/Proton -- it doesn't confirm inbox delivery.
 */
export async function sendMagicLinkSmoke(base, email, fetchImpl = fetch) {
  const tokenResponse = await fetchImpl(`${base}/blog/members/api/integrity-token/`);
  if (!tokenResponse.ok) {
    return { ok: false, step: 'integrity-token', status: tokenResponse.status };
  }
  const integrityToken = await tokenResponse.text();

  const sendResponse = await fetchImpl(`${base}/blog/members/api/send-magic-link/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, emailType: 'signin', integrityToken, autoRedirect: false }),
  });
  if (!sendResponse.ok) {
    const detail = await sendResponse.text().catch(() => '');
    return { ok: false, step: 'send-magic-link', status: sendResponse.status, detail };
  }
  return { ok: true };
}
