import crypto from 'node:crypto';

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function generateAdminToken({ keyId, secretHex }, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: 'HS256', typ: 'JWT', kid: keyId };
  const payload = { iat, exp: iat + 300, aud: '/admin/' };

  const headerB64 = base64url(header);
  const payloadB64 = base64url(payload);
  const signature = crypto
    .createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  return `${headerB64}.${payloadB64}.${signature}`;
}
