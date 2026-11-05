import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPageImages, encodePageImages, decodePageImages } from '../src/page-images.js';

const PAGE_SIZE = 16;
const FRAME_HEADER_SIZE = 24;

function buildFrame({ pageNumber, pageByte, pageSize = PAGE_SIZE }) {
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header.writeUInt32BE(pageNumber, 0);
  const page = Buffer.alloc(pageSize, pageByte);
  return Buffer.concat([header, page]);
}

test('extractPageImages pulls page bytes out at the correct offset', () => {
  const frame = buildFrame({ pageNumber: 3, pageByte: 0xaa });
  const frames = [{ pageNumber: 3, offset: 0, length: frame.length }];
  const pages = extractPageImages(frame, frames, PAGE_SIZE);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].pageNumber, 3);
  assert.equal(pages[0].bytes.length, PAGE_SIZE);
  assert.ok(pages[0].bytes.every((b) => b === 0xaa));
});

test('extractPageImages dedupes to the last occurrence of a repeated page number', () => {
  const frameA = buildFrame({ pageNumber: 5, pageByte: 0x01 });
  const frameB = buildFrame({ pageNumber: 5, pageByte: 0x02 });
  const buf = Buffer.concat([frameA, frameB]);
  const frames = [
    { pageNumber: 5, offset: 0, length: frameA.length },
    { pageNumber: 5, offset: frameA.length, length: frameB.length },
  ];
  const pages = extractPageImages(buf, frames, PAGE_SIZE);
  assert.equal(pages.length, 1);
  assert.ok(pages[0].bytes.every((b) => b === 0x02), 'must keep the LAST write to page 5, not the first');
});

test('extractPageImages preserves distinct page numbers independently', () => {
  const frameA = buildFrame({ pageNumber: 1, pageByte: 0x10 });
  const frameB = buildFrame({ pageNumber: 2, pageByte: 0x20 });
  const buf = Buffer.concat([frameA, frameB]);
  const frames = [
    { pageNumber: 1, offset: 0, length: frameA.length },
    { pageNumber: 2, offset: frameA.length, length: frameB.length },
  ];
  const pages = extractPageImages(buf, frames, PAGE_SIZE);
  assert.equal(pages.length, 2);
  const byPage = Object.fromEntries(pages.map((p) => [p.pageNumber, p.bytes]));
  assert.ok(byPage[1].every((b) => b === 0x10));
  assert.ok(byPage[2].every((b) => b === 0x20));
});

test('encodePageImages then decodePageImages round-trips page number and bytes exactly', () => {
  const pages = [
    { pageNumber: 1, bytes: Buffer.from([1, 2, 3]) },
    { pageNumber: 7, bytes: Buffer.from([9, 9, 9, 9]) },
  ];
  const encoded = encodePageImages(pages);
  assert.ok(Buffer.isBuffer(encoded));
  const decoded = decodePageImages(encoded);
  assert.deepEqual(decoded, pages);
});
