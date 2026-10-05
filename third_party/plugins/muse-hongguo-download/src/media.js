/** Plain MP4 structure checks; successful checks do not claim full codec decoding. */
import { open } from 'node:fs/promises';
import { DownloadError } from './errors.js';

const fail = () => { throw new DownloadError('invalid_media', '媒体不是完整的无加密 MP4；没有生成下载成功结果'); };
const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf']);

function inspectBoxes(buffer, start = 0, end = buffer.length, depth = 0) {
  if (depth > 16) fail();
  let position = start;
  while (position < end) {
    if (position + 8 > end) fail();
    let size = buffer.readUInt32BE(position), header = 8;
    const type = buffer.toString('ascii', position + 4, position + 8);
    if (size === 1) {
      if (position + 16 > end) fail();
      const wide = buffer.readBigUInt64BE(position + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) fail();
      size = Number(wide); header = 16;
    } else if (size === 0) size = end - position;
    if (size < header || position + size > end) fail();
    if (['encv', 'enca', 'sinf', 'pssh'].includes(type)) throw new DownloadError('encrypted_media', '媒体包含加密标记，插件不支持解密');
    if (containers.has(type)) inspectBoxes(buffer, position + header, position + size, depth + 1);
    if (type === 'stsd') {
      if (size < header + 8) fail();
      const entries = buffer.readUInt32BE(position + header + 4);
      let item = position + header + 8;
      for (let index = 0; index < entries; index++) {
        if (item + 8 > position + size) fail();
        const entrySize = buffer.readUInt32BE(item), format = buffer.toString('ascii', item + 4, item + 8);
        if (entrySize < 8 || item + entrySize > position + size) fail();
        if (['encv', 'enca'].includes(format)) throw new DownloadError('encrypted_media', '媒体包含加密音视频，插件不支持解密');
        item += entrySize;
      }
      if (item !== position + size) fail();
    }
    position += size;
  }
}

/** Check complete top-level boxes, track metadata and nonempty media payload from an owned file. */
export async function validateMp4(path) {
  const file = await open(path, 'r');
  try {
    const { size: length } = await file.stat();
    const top = new Set();
    let position = 0, mediaBytes = 0, tracks = false;
    const header = Buffer.alloc(16);
    while (position < length) {
      if (length - position < 8) fail();
      const read = await file.read(header, 0, Math.min(16, length - position), position);
      if (read.bytesRead < 8) fail();
      let size = header.readUInt32BE(0), width = 8;
      const type = header.toString('ascii', 4, 8);
      if (!/^[a-zA-Z0-9 ]{4}$/.test(type)) fail();
      if (size === 1) {
        if (read.bytesRead < 16) fail();
        const wide = header.readBigUInt64BE(8);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) fail();
        size = Number(wide); width = 16;
      } else if (size === 0) size = length - position;
      if (size < width || position + size > length) fail();
      if (type === 'ftyp' && (position !== 0 || size < width + 8)) fail();
      if (type === 'moov') {
        if (size > 64 * 1024 * 1024) fail();
        const data = Buffer.alloc(size);
        const content = await file.read(data, 0, size, position);
        if (content.bytesRead !== size) fail();
        inspectBoxes(data);
        tracks = data.includes(Buffer.from('trak'));
      }
      if (['encv', 'enca', 'sinf', 'pssh'].includes(type)) throw new DownloadError('encrypted_media', '媒体包含加密标记，插件不支持解密');
      if (type === 'mdat') mediaBytes += size - width;
      top.add(type); position += size;
    }
    if (!top.has('ftyp') || !top.has('moov') || !top.has('mdat') || !tracks || mediaBytes < 1) fail();
    return { format: 'mp4', validationLevel: 'mp4-container-length-sha256', fullDecodeChecked: false };
  } finally { await file.close(); }
}
