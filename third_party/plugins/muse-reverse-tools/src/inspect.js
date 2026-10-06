/** Read-only binary identification and Mach-O symbol inspection; no target execution or network access. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function range(data, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > data.length) throw new Error('Truncated or invalid binary structure');
}

/** Parse static executable metadata; unsupported containers remain identified without unpacking them. */
export function inspectBytes(data, { maxSymbols, maxSymbolNameBytes, symbolContains = '' }) {
  const result = { format: 'unknown', symbols: [], totalSymbols: 0, symbolsTruncated: false };
  if (data.length < 4) return result;
  const magic = data.readUInt32LE(0);
  if (magic === 0xfeedfacf || magic === 0xfeedface || magic === 0xcffaedfe || magic === 0xcefaedfe) {
    const little = magic === 0xfeedfacf || magic === 0xfeedface;
    const wide = magic === 0xfeedfacf || magic === 0xcffaedfe;
    const headerBytes = wide ? 32 : 28;
    range(data, 0, headerBytes);
    const u32 = offset => little ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
    const u64 = offset => little ? data.readBigUInt64LE(offset) : data.readBigUInt64BE(offset);
    const count = u32(16), commandBytes = u32(20), cpu = u32(4);
    result.format = 'Mach-O'; result.bits = wide ? 64 : 32;
    result.architecture = ({ 0x100000c: 'arm64', 0x1000007: 'x86_64', 12: 'arm', 7: 'x86' })[cpu] || `cpu-${cpu}`;
    result.fileType = u32(12); result.flags = u32(24);
    range(data, headerBytes, commandBytes);
    if (count > Math.floor(commandBytes / 8)) throw new Error('Invalid Mach-O command count');
    let offset = headerBytes;
    for (let i = 0; i < count; i++) {
      range(data, offset, 8);
      const kind = u32(offset), size = u32(offset + 4);
      if (size < 8 || offset + size > headerBytes + commandBytes) throw new Error('Invalid Mach-O load command');
      if (kind === 2) {
        if (size < 24) throw new Error('Invalid Mach-O symbol command');
        const symbolOffset = u32(offset + 8), symbolCount = u32(offset + 12), stringOffset = u32(offset + 16), stringBytes = u32(offset + 20);
        const stride = wide ? 16 : 12;
        range(data, symbolOffset, symbolCount * stride); range(data, stringOffset, stringBytes);
        result.totalSymbols += symbolCount;
        for (let index = 0; index < symbolCount; index++) {
          const entry = symbolOffset + index * stride, nameOffset = u32(entry);
          if (nameOffset >= stringBytes) throw new Error('Invalid Mach-O symbol string');
          if (nameOffset === 0) continue;
          const start = stringOffset + nameOffset;
          const bounded = data.subarray(start, Math.min(stringOffset + stringBytes, start + maxSymbolNameBytes + 1));
          const terminator = bounded.indexOf(0);
          if (terminator < 0 && bounded.length <= maxSymbolNameBytes) throw new Error('Unterminated Mach-O symbol string');
          const name = bounded.toString('utf8', 0, terminator < 0 ? maxSymbolNameBytes : terminator);
          if (!name.includes(symbolContains)) continue;
          if (result.symbols.length >= maxSymbols) { result.symbolsTruncated = true; continue; }
          result.symbols.push({ name, address: `0x${(wide ? u64(entry + 8) : BigInt(u32(entry + 8))).toString(16)}`,
            ...(terminator < 0 ? { nameTruncated: true } : {}) });
        }
      }
      offset += size;
    }
  } else if (data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    range(data, 0, 20);
    result.format = 'ELF'; result.bits = data[4] === 2 ? 64 : data[4] === 1 ? 32 : null;
    result.machine = data[5] === 1 ? data.readUInt16LE(18) : data.readUInt16BE(18);
  } else if (data[0] === 0x4d && data[1] === 0x5a) {
    range(data, 0, 64);
    const pe = data.readUInt32LE(60); range(data, pe, 24);
    if (!data.subarray(pe, pe + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))) throw new Error('Invalid PE signature');
    result.format = 'PE'; result.machine = data.readUInt16LE(pe + 4); result.sections = data.readUInt16LE(pe + 6);
  } else if (data.length >= 512 && data.toString('ascii', data.length - 512, data.length - 508) === 'koly') result.format = 'UDIF-DMG';
  else if (data[0] === 0x50 && data[1] === 0x4b) result.format = 'ZIP';
  return result;
}

/** Inspect a regular workspace file, enforce a byte ceiling and preserve the original. */
export async function inspectFile(args, workspace, settings, signal) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.path !== 'string' || !args.path.trim()
    || Object.keys(args).some(key => !['path', 'symbolContains'].includes(key))
    || args.symbolContains !== undefined && (typeof args.symbolContains !== 'string' || args.symbolContains.length > 200)) throw new TypeError('Invalid reverse analysis arguments');
  signal.throwIfAborted();
  const root = await realpath(workspace), lexical = resolve(root, args.path);
  if (!inside(root, lexical)) throw new Error('Analysis target must be inside the active workspace');
  const target = await realpath(lexical);
  if (!inside(root, target) || !(await lstat(lexical)).isFile()) throw new Error('Linked or non-file analysis target refused');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > settings.maxFileBytes) throw new Error('Analysis target exceeds the configured file limit');
    const chunks = []; let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      bytes += chunk.length;
      if (bytes > settings.maxFileBytes) throw new Error('Analysis target exceeds the configured file limit');
      chunks.push(chunk);
    }
    const after = await handle.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Analysis target changed while reading');
    const data = Buffer.concat(chunks);
    return { status: 'inspected', path: target, bytes, sha256: createHash('sha256').update(data).digest('hex'),
      ...inspectBytes(data, { maxSymbols: settings.maxSymbols, maxSymbolNameBytes: settings.maxSymbolNameBytes, symbolContains: args.symbolContains }),
      limitation: 'Static metadata only; no program execution, decompilation, recovered source or download-success claim. PE/ELF symbol extraction and archive unpacking require the routed optional tooling.' };
  } finally { await handle.close(); }
}
