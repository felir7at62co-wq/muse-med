/** Private CENC worker: the pinned engine owns MP4 decryption; keys never enter process arguments. */
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { openSync, fstatSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
try {
  const { inputPath, outputPath, contentKey, maxBytes } = workerData;
  if (!isAbsolute(inputPath) || !isAbsolute(outputPath) || inputPath === outputPath
    || !/^[a-f\d]{32}$/i.test(contentKey) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('invalid worker input');
  const fd = openSync(inputPath, 'r');
  let data;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) throw new Error('input size');
    data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (count === 0) throw new Error('incomplete input');
      offset += count;
    }
  } finally { closeSync(fd); }
  const engine = createRequire(import.meta.url)('../upstream/engine.cjs');
  const decoded = engine.decryptMp4Buffer(data, Buffer.from(contentKey, 'hex'));
  if (decoded.length <= 0 || decoded.length > maxBytes) throw new Error('output size');
  writeFileSync(outputPath, decoded, { flag: 'wx', mode: 0o600 });
  parentPort.postMessage({ ok: true });
} catch (error) { parentPort.postMessage({ ok: false }); }
