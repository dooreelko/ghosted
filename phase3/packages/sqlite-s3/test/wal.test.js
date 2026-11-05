import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWalHeader, parseFrames, writeSetFromFrames } from '../src/wal.js';

const PAGE_SIZE = 16;

function buildWalHeader({ pageSize = PAGE_SIZE } = {}) {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(0x377f0682, 0);
  buf.writeUInt32BE(3007000, 4);
  buf.writeUInt32BE(pageSize, 8);
  buf.writeUInt32BE(0, 12);
  buf.writeUInt32BE(111, 16);
  buf.writeUInt32BE(222, 20);
  buf.writeUInt32BE(0, 24);
  buf.writeUInt32BE(0, 28);
  return buf;
}

function buildFrame({ pageNumber, dbSizeAfterCommit = 0, pageSize = PAGE_SIZE }) {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(pageNumber, 0);
  header.writeUInt32BE(dbSizeAfterCommit, 4);
  const page = Buffer.alloc(pageSize, 0xab);
  return Buffer.concat([header, page]);
}

test('parseWalHeader reads magic and page size', () => {
  const header = buildWalHeader();
  const parsed = parseWalHeader(header);
  assert.equal(parsed.magic, 0x377f0682);
  assert.equal(parsed.pageSize, PAGE_SIZE);
  assert.equal(parsed.salt1, 111);
  assert.equal(parsed.salt2, 222);
});

test('parseWalHeader rejects a buffer with bad magic', () => {
  const bad = buildWalHeader();
  bad.writeUInt32BE(0xdeadbeef, 0);
  assert.throws(() => parseWalHeader(bad), /Not a WAL file/);
});

test('parseFrames walks a full wal file (header + two frames, one commit)', () => {
  const header = buildWalHeader();
  const f1 = buildFrame({ pageNumber: 3 });
  const f2 = buildFrame({ pageNumber: 7, dbSizeAfterCommit: 9 });
  const buf = Buffer.concat([header, f1, f2]);
  const frames = parseFrames(buf, PAGE_SIZE);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].pageNumber, 3);
  assert.equal(frames[0].dbSizeAfterCommit, 0);
  assert.equal(frames[1].pageNumber, 7);
  assert.equal(frames[1].dbSizeAfterCommit, 9);
});

test('parseFrames with a non-default startOffset (no header in this delta)', () => {
  const f1 = buildFrame({ pageNumber: 5, dbSizeAfterCommit: 5 });
  const frames = parseFrames(f1, PAGE_SIZE, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].pageNumber, 5);
});

test('writeSetFromFrames dedupes and sorts page numbers', () => {
  const frames = [{ pageNumber: 9 }, { pageNumber: 3 }, { pageNumber: 9 }];
  assert.deepEqual(writeSetFromFrames(frames), [3, 9]);
});
