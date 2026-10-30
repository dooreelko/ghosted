#!/usr/bin/env node
// Compare what the generator wrote to the content bucket with what the live site serves,
// object by object. Differences that come from the Ghost release or the moment of the run (generator tags,
// the portal and search script versions, sitemap and feed timestamps) are ignored; everything else is reported.
//
// Usage: node phase3/scripts/validate-parity.mjs <bucket> <site origin, e.g. https://example.com>
import { execFileSync } from 'node:child_process';

const [bucket, origin] = process.argv.slice(2);
if (!bucket || !origin) { console.error('usage: validate-parity.mjs <bucket> <origin>'); process.exit(2); }

const list = JSON.parse(execFileSync('aws', ['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', 'blog/', '--output', 'json'], { maxBuffer: 1 << 28 }).toString());
const keys = (list.Contents ?? []).map((o) => o.Key).filter((k) => !k.startsWith('blog/content/images/')).sort();

const normalize = (text) => text
  .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16))) // 6.73 escapes more characters as references
  .replace(/<lastmod>[^<]*<\/lastmod>/g, '<lastmod>X</lastmod>').replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/g, '<lastBuildDate>X</lastBuildDate>').replace(/<generator>Ghost [^<]*<\/generator>/g, '<generator>Ghost X</generator>')
  .replace(/<meta name="generator" content="Ghost [^"]*">/g, '<meta name="generator" content="Ghost X">')
  .replace(/portal@~[0-9.]+/g, 'portal@~X').replace(/sodo-search@~[0-9.]+/g, 'sodo-search@~X')
  .replace(/comments-ui@~[0-9.]+/g, 'comments-ui@~X').replace(/announcement-bar@~[0-9.]+/g, 'announcement-bar@~X');

const urlFor = (key) => {
  const p = key.replace(/^blog\//, '');
  if (p === '404.html') return `${origin}/blog/this-page-does-not-exist-404/`;
  if (p === 'index.html') return `${origin}/blog/`;
  if (p.endsWith('/index.html')) return `${origin}/blog/${p.slice(0, -'index.html'.length)}`;
  return `${origin}/blog/${p}`;
};

const get = async (url) => { const r = await fetch(url, { redirect: 'manual' }); return { status: r.status, body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') ?? '' }; };
const mine = (key) => execFileSync('aws', ['s3', 'cp', `s3://${bucket}/${key}`, '-', '--only-show-errors'], { maxBuffer: 1 << 28 });

let same = 0;
const diffs = [];
for (const key of keys) {
  const url = urlFor(key);
  let live;
  try { live = await get(url); } catch (e) { diffs.push([key, `live fetch failed: ${e.message}`]); continue; }
  const expectStatus = key === 'blog/404.html' ? 404 : 200;
  if (live.status !== expectStatus) { diffs.push([key, `live status ${live.status}, expected ${expectStatus}`]); continue; }
  const a = mine(key);
  const textual = /^(text|application\/(xml|rss|atom|json|javascript))/.test(live.type) || /xml|html|json|javascript|text/.test(live.type);
  const equal = textual ? normalize(a.toString('utf8')) === normalize(live.body.toString('utf8')) : a.equals(live.body);
  if (equal) same += 1; else diffs.push([key, `content differs (${a.length}B generated, ${live.body.length}B live)`]);
}
console.log(`${keys.length} objects checked: ${same} identical, ${diffs.length} different`);
for (const [k, why] of diffs) console.log(`  ${k}: ${why}`);
process.exit(diffs.length ? 1 : 0);
