// Ghost's bulk newsletter send goes through its Mailgun client, which loads form-data and mailgun.js
// only when it sends. Send one batch to a local stand-in for the Mailgun API so those modules are
// loaded here (and kept by the prune). Needs GHOST_ROOT.
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const ghostRequire = createRequire(path.join(process.env.GHOST_ROOT, 'core', 'x.js'));
let received;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received = { url: req.url, auth: req.headers.authorization?.slice(0, 10), body: Buffer.concat(chunks).toString() };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: '<practice@mg.example.test>', message: 'Queued. Thank you.' }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const MailgunClient = ghostRequire(path.join(process.env.GHOST_ROOT, 'core/server/lib/mailgun/mailgun-client.js'));
const config = { get: (k) => (k === 'bulkEmail' ? { mailgun: { apiKey: 'key-test', domain: 'mg.example.test', baseUrl } } : undefined) };
const client = new MailgunClient({ config, settings: { get: () => undefined } });
const response = await client.send(
  { subject: 'Practice', html: '<p>Hi %recipient.name%</p>', plaintext: 'Hi', from: 'a@example.test', id: 'email1' },
  { 'reader@example.test': { name: 'Reader', unsubscribe_url: 'https://example.test/u', list_unsubscribe: 'https://example.test/u' } },
  [{ id: 'name', format: 'html', regexp: /%%\{name\}%%/g }],
);
console.log('mailgun stand-in got', received?.url, received?.auth, '| response', JSON.stringify(response));
let failed = false;
if (!received?.url?.includes('/messages') || !received.body.includes('reader@example.test')) { console.error('FAIL: the batch did not reach the Mailgun stand-in'); failed = true; }
server.close();
process.exit(failed ? 1 : 0);
