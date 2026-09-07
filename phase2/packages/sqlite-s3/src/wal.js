const WAL_HEADER_SIZE = 32;
const FRAME_HEADER_SIZE = 24;
const WAL_MAGIC_BIG_ENDIAN_CKSUM = 0x377f0682;
const WAL_MAGIC_LITTLE_ENDIAN_CKSUM = 0x377f0683;

export function parseWalHeader(buf) {
  if (buf.length < WAL_HEADER_SIZE) {
    throw new Error('WAL header truncated');
  }
  const magic = buf.readUInt32BE(0);
  if (magic !== WAL_MAGIC_BIG_ENDIAN_CKSUM && magic !== WAL_MAGIC_LITTLE_ENDIAN_CKSUM) {
    throw new Error(`Not a WAL file (bad magic 0x${magic.toString(16)})`);
  }
  return {
    magic,
    formatVersion: buf.readUInt32BE(4),
    pageSize: buf.readUInt32BE(8),
    checkpointSeq: buf.readUInt32BE(12),
    salt1: buf.readUInt32BE(16),
    salt2: buf.readUInt32BE(20),
  };
}

export function parseFrames(buf, pageSize, startOffset = WAL_HEADER_SIZE) {
  const frameSize = FRAME_HEADER_SIZE + pageSize;
  const frames = [];
  let offset = startOffset;
  while (offset + frameSize <= buf.length) {
    const pageNumber = buf.readUInt32BE(offset);
    const dbSizeAfterCommit = buf.readUInt32BE(offset + 4);
    frames.push({ pageNumber, dbSizeAfterCommit, offset, length: frameSize });
    offset += frameSize;
  }
  return frames;
}

export function writeSetFromFrames(frames) {
  return [...new Set(frames.map((f) => f.pageNumber))].sort((a, b) => a - b);
}

export const WAL_HEADER_SIZE_BYTES = WAL_HEADER_SIZE;
export const FRAME_HEADER_SIZE_BYTES = FRAME_HEADER_SIZE;
