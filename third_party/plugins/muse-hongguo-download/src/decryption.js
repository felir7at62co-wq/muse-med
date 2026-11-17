/** Bounded worker ownership keeps CENC processing off the Host event loop. */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DownloadError } from './errors.js';
import { mediaCleanupError } from './media-ownership.js';
const workerPath = fileURLToPath(new URL('./decrypt-worker.js', import.meta.url))
  .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2');
const failed = () => new DownloadError('decryption_failed', '加密视频解密失败；没有生成下载成功回执');

/**
 * Create a bounded worker queue that joins worker exit on success and cancellation.
 * @param {object} config Validated memory and concurrency limits.
 * @param {object} options Optional worker provider; omitted uses native Worker threads.
 * @returns {Function} Decrypt one owned file; unconfirmed exit quarantines the queue.
 */
export function createDecryptor(config, { createWorker = (path, options) => new Worker(path, options) } = {}) {
  const waiting = [];
  let running = 0, quarantinedPath = null;
  function drain() {
    if (quarantinedPath) {
      for (const entry of waiting.splice(0)) { entry.signal.removeEventListener('abort', entry.abort); entry.reject(mediaCleanupError(quarantinedPath)); }
      return;
    }
    while (running < config.decryptionConcurrency && waiting.length) {
      const entry = waiting.shift();
      entry.signal.removeEventListener('abort', entry.abort);
      if (entry.signal.aborted) { entry.reject(entry.signal.reason); continue; }
      running++;
      entry.resolve(() => { running--; drain(); });
    }
  }
  async function acquire(signal) {
    signal.throwIfAborted();
    if (quarantinedPath) throw mediaCleanupError(quarantinedPath);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, abort: () => {
        const index = waiting.indexOf(entry);
        if (index !== -1) waiting.splice(index, 1);
        reject(signal.reason);
      } };
      waiting.push(entry);
      signal.addEventListener('abort', entry.abort, { once: true });
      drain();
    });
  }
  return async ({ inputPath, outputPath, contentKey, signal }) => {
    signal.throwIfAborted();
    const info = await lstat(inputPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > config.maxDecryptionBytes) throw new DownloadError('decryption_size', '加密视频超过 maxDecryptionBytes 或不是普通文件；未启动解密');
    const release = await acquire(signal);
    try {
      signal.throwIfAborted();
      await new Promise((resolve, reject) => {
        let worker, finishing = false;
        const finish = async error => {
          if (finishing) return;
          finishing = true;
          signal.removeEventListener('abort', cancel);
          try { await worker.terminate(); }
          catch (terminationError) {
            quarantinedPath = dirname(outputPath); drain();
            reject(mediaCleanupError(quarantinedPath)); return;
          }
          if (signal.aborted) reject(signal.reason);
          else if (error) reject(error);
          else resolve();
        };
        const cancel = () => { void finish(signal.reason); };
        try {
          worker = createWorker(workerPath, { workerData: { inputPath, outputPath, contentKey, maxBytes: config.maxDecryptionBytes },
            resourceLimits: { maxOldGenerationSizeMb: config.decryptionWorkerHeapMb }, stdout: true, stderr: true });
        } catch (error) { reject(failed()); return; }
        worker.stdout.resume(); worker.stderr.resume();
        worker.once('message', value => { void finish(value?.ok === true ? null : failed()); });
        worker.once('error', () => { void finish(failed()); });
        worker.once('exit', () => { if (!finishing) void finish(failed()); });
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
    } finally { if (!quarantinedPath) release(); }
  };
}
