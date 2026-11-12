/** Local decryption and complete playback validation through the managed subprocess service. */
import { fileURLToPath } from 'node:url';
import { open, lstat, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createDecryptor } from './decryption.js';
import { pendingMediaProcess, mediaCleanupError, createMediaLease } from './media-ownership.js';
import { DownloadError } from './errors.js';

const bridge = fileURLToPath(new URL('../python/decrypt.py', import.meta.url))
  .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2');
const bootstrapBridge = fileURLToPath(new URL('../python/bootstrap.py', import.meta.url))
  .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2');
const outputBytes = 64 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failures = {
  runtime: ['missing_media_runtime', '缺少有效的本地视频处理运行时；请配置 Python、FFmpeg 和 FFprobe 的绝对路径'],
  decrypt: ['decryption_failed', '原源加密视频解密失败；未完成文件已清理'],
  probe: ['invalid_media', '视频没有有效的时长、视频编码或画面尺寸；未完成文件已清理'],
  bytevc2: ['missing_bytevc2_runtime', '缺少有效的 ByteVC2 解码组件；请更新 Muse 或配置 bytevc2Executable'],
  convert: ['conversion_failed', 'ByteVC2 转换失败；已验证文件保留，未完成文件已清理'],
  decode: ['decode_failed', '视频完整解码验证失败；未完成文件已清理'],
};
const failure = kind => new DownloadError(...failures[kind]);

function captured(handle, stream, kind) {
  const output = handle.collected[stream]?.readFrom(0);
  if (!output || typeof output.text !== 'string' || output.lossy || output.truncated
    || Buffer.byteLength(output.text) > outputBytes) throw failure(kind);
  return output.text;
}

function probeDuration(text) {
  let value;
  try { value = JSON.parse(text); } catch (error) { throw failure('probe'); }
  const rawDuration = record(value) && record(value.format) ? value.format.duration : null;
  const duration = typeof rawDuration === 'number' || (typeof rawDuration === 'string' && /^\d+(?:\.\d+)?$/.test(rawDuration)) ? Number(rawDuration) : NaN;
  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(value.streams)
    || !value.streams.some(stream => record(stream) && stream.codec_type === 'video'
      && typeof stream.codec_name === 'string' && /^[a-z0-9_]{1,64}$/i.test(stream.codec_name)
      && !['unknown', 'none', 'n_a'].includes(stream.codec_name.toLowerCase())
      && Number.isSafeInteger(stream.width) && stream.width > 0 && Number.isSafeInteger(stream.height) && stream.height > 0)) throw failure('probe');
  return duration;
}

/**
 * Build a lazy, shared bootstrap for the original device generator in a private writable app directory.
 * @param {object} subprocess Managed subprocess service owning Python and its descendants.
 * @param {object} config Resolved original directory, Python path and startup deadline.
 * @returns {object} ensure/dispose operations that wait for process and file cleanup.
 */
export function createDeviceBootstrap(subprocess, config) {
  const lifetime = new AbortController();
  let state = null, ready = false;
  const failed = () => new DownloadError('invalid_original_source', '本机原源设备初始化失败；请检查内置 Python 3.11 和原设备生成模块');

  async function start(owned) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), config.deviceBootstrapTimeoutMs);
    const active = AbortSignal.any([lifetime.signal, owned.controller.signal, deadline.signal]);
    let handle;
    try {
      active.throwIfAborted();
      if (!subprocess || !config.pythonExecutable || !config.legacyAppDir) throw failed();
      const python = await subprocess.resolveExecutable(config.pythonExecutable, undefined, active);
      active.throwIfAborted();
      handle = subprocess.spawn({ argv: [python, '-I', '-B', bootstrapBridge], cwd: config.legacyAppDir,
        stdio: { stdin: { data: JSON.stringify({ appDir: config.legacyAppDir }) }, stdout: { maxBytes: outputBytes }, stderr: { maxBytes: outputBytes } },
        graceMs: config.mediaProcessGraceMs, signal: active });
      const outcome = await handle.done;
      if (!await handle.waitForExit(active)) { handle.terminate(); await handle.waitForExit(); }
      active.throwIfAborted();
      if (outcome.exitCode !== 0 || outcome.signal) throw failed();
      const stdout = captured(handle, 'stdout', 'runtime'), stderr = captured(handle, 'stderr', 'runtime');
      if (stderr.trim()) throw failed();
      let result;
      try { result = JSON.parse(stdout); } catch (error) { throw failed(); }
      if (!record(result) || result.ok !== true) throw failed();
      ready = true;
    } catch (error) {
      if (handle) {
        handle.terminate();
        await Promise.allSettled([handle.done, handle.waitForExit()]);
      }
      if (active.aborted) throw new DownloadError('cancelled', '本机设备初始化已取消或超过时限；未完成数据已清理');
      throw failed();
    } finally {
      clearTimeout(timer);
      if (state === owned) state = null;
    }
  }

  return {
    async ensure(signal) {
      signal.throwIfAborted();
      if (lifetime.signal.aborted) throw new DownloadError('cancelled', '本机设备初始化已取消');
      if (ready) return;
      let owned = state;
      if (!owned) {
        owned = { controller: new AbortController(), waiters: new Set() };
        state = owned;
        owned.work = start(owned);
      }
      const waiter = {};
      owned.waiters.add(waiter);
      let abort;
      const cancelled = new Promise((_resolve, reject) => {
        abort = () => reject(new DownloadError('cancelled', '本机设备初始化已取消'));
        signal.addEventListener('abort', abort, { once: true });
      });
      try { await Promise.race([owned.work, cancelled]); }
      finally {
        signal.removeEventListener('abort', abort);
        owned.waiters.delete(waiter);
        if (!ready && !owned.waiters.size) {
          owned.controller.abort();
          await Promise.allSettled([owned.work]);
        }
      }
    },
    async dispose() {
      lifetime.abort();
      if (state) await Promise.allSettled([state.work]);
    },
  };
}

/**
 * Build a processor for caller-owned absolute staging paths; ByteVC2 keys stay in worker memory; no private decryption data enters tool results.
 * @param {object} subprocess Managed subprocess service in the same execution world as the files.
 * @param {object} config Resolved executable paths, download deadline and termination grace.
 * @param {object} dependencies Optional decryption provider; omitted uses the pinned engine in owned workers.
 * @returns {Function} Processor returning validated path and complete decode facts; converted output includes an owner-checked cleanup callback.
 */
export function createMediaProcessor(subprocess, config, dependencies = {}) {
  const decrypt = dependencies.decrypt ?? createDecryptor(config);
  const waiting = [];
  let converting = 0, quarantinedPath = null;
  const ownedLeases = new Set();
  function acquire(signal) {
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
  function drain() {
    if (quarantinedPath) {
      for (const entry of waiting.splice(0)) { entry.signal.removeEventListener('abort', entry.abort); entry.reject(mediaCleanupError(quarantinedPath)); }
      return;
    }
    while (converting < config.bytevc2Concurrency && waiting.length) {
      const entry = waiting.shift();
      entry.signal.removeEventListener('abort', entry.abort);
      if (entry.signal.aborted) { entry.abort(); continue; }
      converting++;
      entry.resolve(() => { converting--; drain(); });
    }
  }
  return async (media, { inputPath, outputPath, workspace, signal }) => {
    const encrypted = media.encryption !== null && media.encryption !== undefined;
    const bytevc2 = media.codec === 'bytevc2';
    if (quarantinedPath) throw mediaCleanupError(quarantinedPath);
    if (bytevc2 && (!Number.isFinite(media.expectedDuration) || media.expectedDuration <= 0
      || !Number.isSafeInteger(media.expectedWidth) || media.expectedWidth <= 0
      || !Number.isSafeInteger(media.expectedHeight) || media.expectedHeight <= 0)) throw new DownloadError('invalid_source_metadata', 'ByteVC2 来源缺少有效时长或画面尺寸；未开始转换');
    const names = ['ffprobeExecutable', 'ffmpegExecutable', ...(bytevc2 ? ['bytevc2Executable'] : []), ...(encrypted && !media.encryption.contentKey ? ['pythonExecutable'] : [])];
    if (bytevc2 && !config.bytevc2Executable) throw failure('bytevc2');
    if (!subprocess || names.some(name => !config[name]) || (encrypted && !media.encryption.contentKey && !config.legacyAppDir)) throw failure('runtime');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), config.downloadTimeoutMs);
    const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;

    let release, outputIdentity, lease, leaseIdentity;
    let unconfirmed = false;
    async function cleanupOutput() {
      if (!outputIdentity || unconfirmed) return;
      let info;
      try { info = await lstat(outputPath, { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (info.isFile() && !info.isSymbolicLink() && info.dev === outputIdentity.dev && info.ino === outputIdentity.ino) await rm(outputPath);
    }

    async function run(argv, stdin, kind) {
      let handle;
      try {
        active.throwIfAborted();
        handle = subprocess.spawn({ argv, cwd: workspace, stdio: { stdin, stdout: { maxBytes: outputBytes }, stderr: { maxBytes: outputBytes } },
          graceMs: config.mediaProcessGraceMs, signal: active });
        const outcome = await handle.done;
        if (!await handle.waitForExit(active)) {
          handle.terminate();
          await handle.waitForExit();
        }
        active.throwIfAborted();
        if (outcome.exitCode !== 0 || outcome.signal) throw failure(kind);
        const stdout = captured(handle, 'stdout', kind), stderr = captured(handle, 'stderr', kind);
        if (stderr.trim()) throw failure(kind);
        return stdout;
      } catch (error) {
        if (handle) {
          let terminated = true;
          try { handle.terminate(); } catch (terminationError) { terminated = false; }
          const outcomes = await Promise.allSettled([handle.done, handle.waitForExit()]);
          if (!terminated || outcomes[1].status !== 'fulfilled' || outcomes[1].value !== true) {
            unconfirmed = true;
            quarantinedPath = lease ?? workspace;
            drain();
            throw mediaCleanupError(quarantinedPath);
          }
        }
        if (active.aborted) throw active.reason;
        throw failure(kind);
      }
    }

    try {
      active.throwIfAborted();
      const pending = await pendingMediaProcess(workspace, ownedLeases);
      if (pending) { quarantinedPath = pending; throw mediaCleanupError(pending); }
      if (bytevc2) release = await acquire(active);
      lease = await createMediaLease(workspace, [inputPath, outputPath], ownedLeases);
      leaseIdentity = await lstat(lease, { bigint: true });
      const lookup = await Promise.allSettled(names.map(name => subprocess.resolveExecutable(config[name], undefined, active)));
      active.throwIfAborted();
      if (lookup.some((item, index) => item.status === 'rejected' && names[index] === 'bytevc2Executable')) throw failure('bytevc2');
      if (lookup.some(item => item.status === 'rejected')) throw failure('runtime');
      const executables = Object.fromEntries(names.map((name, index) => [name, lookup[index].value]));
      const processedPath = encrypted || bytevc2 ? outputPath : inputPath;
      let clearInput = inputPath;
      if (bytevc2 && encrypted && media.encryption.contentKey) {
        clearInput = join(lease, 'decrypted.mp4');
        await decrypt({ inputPath, outputPath: clearInput, contentKey: media.encryption.contentKey, signal: active });
      }
      if (bytevc2) {
        const decoder = await run([executables.bytevc2Executable, '-v', 'error', '-hide_banner', '-h', 'decoder=bvc2'], 'ignore', 'bytevc2');
        if (!/Decoder bvc2 \[/.test(decoder)) throw failure('bytevc2');
        if (inputPath === outputPath || encrypted && !media.encryption.contentKey) throw failure('convert');
        const file = await open(outputPath, 'wx', 0o600);
        try { outputIdentity = await file.stat({ bigint: true }); } finally { await file.close(); }
        await run([executables.bytevc2Executable, '-y', '-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file,pipe',
          '-filter_threads', '1', '-threads:v', String(config.bytevc2Threads),
          '-i', clearInput,
          '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-threads:v', String(config.bytevc2Threads), '-x264-params', 'lookahead_threads=1', '-c:a', 'aac',
          '-movflags', '+faststart', '-fs', String(config.maxEpisodeBytes), '-f', 'mp4', outputPath], 'ignore', 'convert');
        const info = await lstat(outputPath, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink() || info.dev !== outputIdentity.dev || info.ino !== outputIdentity.ino) throw failure('convert');
        if (info.size <= 0n || info.size >= BigInt(config.maxEpisodeBytes)) throw new DownloadError('media_size', 'ByteVC2 转换结果为空或超过 maxEpisodeBytes；未生成成功回执');
      } else if (encrypted && media.encryption.contentKey) {
        await run([executables.ffmpegExecutable, '-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file,pipe',
          '-decryption_key', media.encryption.contentKey, '-i', inputPath, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
          '-movflags', '+faststart', '-f', 'mp4', outputPath], 'ignore', 'decrypt');
      } else if (encrypted) {
        const text = await run([executables.pythonExecutable, '-I', '-B', bridge], { data: JSON.stringify({
          appDir: config.legacyAppDir, spade: media.encryption.spade, input: inputPath, output: outputPath, ffmpeg: executables.ffmpegExecutable,
        }) }, 'decrypt');
        let result;
        try { result = JSON.parse(text); } catch (error) { throw failure('decrypt'); }
        if (!record(result) || result.ok !== true) throw failure('decrypt');
      }
      const probeText = await run([executables.ffprobeExecutable, '-v', 'error', '-show_entries',
        'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', '-protocol_whitelist', 'file,pipe', '-i', processedPath], 'ignore', 'probe');
      const durationSeconds = probeDuration(probeText);
      const video = JSON.parse(probeText).streams.find(stream => stream.codec_type === 'video');
      if (bytevc2 && (video.codec_name !== 'h264' || JSON.parse(probeText).streams.some(stream => stream.codec_type === 'audio' && stream.codec_name !== 'aac'))) throw failure('convert');
      if (media.expectedWidth && media.expectedHeight && (video.width !== media.expectedWidth || video.height !== media.expectedHeight)) throw failure('probe');
      if (media.quality !== undefined && media.quality !== 'auto' && Math.min(video.width, video.height) < (media.quality === '1080p' ? 1080 : 720)) throw failure('probe');
      if (media.expectedDuration && durationSeconds < media.expectedDuration - Math.max(1, media.expectedDuration * .01)) throw failure('probe');
      const decoded = await run([executables.ffmpegExecutable, '-v', 'error', '-xerror', '-err_detect', 'explode',
        '-protocol_whitelist', 'file,pipe', '-i', processedPath, '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-'], 'ignore', 'decode');
      if (decoded.trim()) throw failure('decode');
      active.throwIfAborted();
      return { processedPath, durationSeconds, fullDecodeChecked: true, validationLevel: 'ffprobe-full-decode-sha256',
        ...(bytevc2 ? { convertedFrom: 'bytevc2', cleanup: cleanupOutput } : {}) };

    } catch (error) {
      if (bytevc2) await cleanupOutput();
      if (error.code === 'cleanup_unconfirmed') { unconfirmed = true; quarantinedPath = lease ?? error.cleanupPendingPath; drain(); throw error; }
      if (active.aborted) throw new DownloadError('cancelled', '视频处理已取消或超过时限；未完成文件已清理');
      if (error instanceof DownloadError) throw error;
      if (bytevc2 && error.code === 'EEXIST') throw new DownloadError('output_exists', 'ByteVC2 转换目标已存在；已有文件已保留');
      throw failure('runtime');
    } finally {
      clearTimeout(timer);
      if (!unconfirmed) {
        if (lease) {
          const info = await lstat(lease, { bigint: true });
          if (info.isDirectory() && !info.isSymbolicLink() && info.dev === leaseIdentity.dev && info.ino === leaseIdentity.ino) {
            await rm(join(lease, 'decrypted.mp4'), { force: true });
            await rm(join(lease, 'lease.json'));
            await rmdir(lease);
          }
          ownedLeases.delete(lease);
        }
        release?.();
      }
    }
  };
}
