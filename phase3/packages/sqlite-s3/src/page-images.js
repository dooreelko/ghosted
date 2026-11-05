import { FRAME_HEADER_SIZE_BYTES } from './wal.js';
import { pack, unpack } from 'msgpackr';

export function extractPageImages(buf, frames, pageSize) {
  const pages = new Map();
  for (const frame of frames) {
    const start = frame.offset + FRAME_HEADER_SIZE_BYTES;
    const bytes = Buffer.from(buf.subarray(start, start + pageSize));
    pages.set(frame.pageNumber, bytes);
  }
  return [...pages.entries()].map(([pageNumber, bytes]) => ({ pageNumber, bytes }));
}

export function encodePageImages(pages) {
  return pack(pages);
}

export function decodePageImages(buf) {
  return unpack(buf);
}
