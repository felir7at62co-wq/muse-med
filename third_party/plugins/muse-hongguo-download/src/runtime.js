/** Local decryption and complete playback validation through the managed subprocess service. */
import { fileURLToPath } from 'node:url';
import { DownloadError } from './errors.js';

const bridge = fileURLToPath(new URL('../python/decrypt.py', import.meta.url))
  .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2');
const outputBytes = 64 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failures = {
  runtime: ['missing_media_runtime', '缺少有效的本地视频处理运行时；请配置 Python、FFmpeg 和 FFprobe 的绝对路径'],
  decrypt: ['decryption_failed', '原源加密视频解密失败；未完成文件已清理'],
  probe: ['invalid_media', '视频没有有效的时长、视频编码或画面尺寸；未完成文件已清理'],
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
 * Build a processor for caller-owned absolute staging paths; private decryption data is written only to batch stdin.
 * @param {object} subprocess Managed subprocess service in the same execution world as the files.
 * @param {object} config Resolved executable paths, download deadline and termination grace.
 * @returns {Function} Processor returning its validated local path and complete decode facts.
 */
export function createMediaProcessor(subprocess, config) {
  return async (media, { inputPath, outputPath, workspace, signal }) => {
    const encrypted = media.encryption !== null && media.encryption !== undefined;
    const names = ['ffprobeExecutable', 'ffmpegExecutable', ...(encrypted ? ['pythonExecutable'] : [])];
    if (!subprocess || names.some(name => !config[name]) || (encrypted && !config.legacyAppDir)) throw failure('runtime');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), config.downloadTimeoutMs);
    const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;

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
          handle.terminate();
          await Promise.allSettled([handle.done, handle.waitForExit()]);
        }
        if (active.aborted) throw active.reason;
        throw failure(kind);
      }
    }

    try {
      active.throwIfAborted();
      const lookup = await Promise.allSettled(names.map(name => subprocess.resolveExecutable(config[name], undefined, active)));
      active.throwIfAborted();
      if (lookup.some(item => item.status === 'rejected')) throw failure('runtime');
      const executables = Object.fromEntries(names.map((name, index) => [name, lookup[index].value]));
      const processedPath = encrypted ? outputPath : inputPath;
      if (encrypted) {
        const text = await run([executables.pythonExecutable, '-I', '-B', bridge], { data: JSON.stringify({
          appDir: config.legacyAppDir, spade: media.encryption.spade, input: inputPath, output: outputPath, ffmpeg: executables.ffmpegExecutable,
        }) }, 'decrypt');
        let result;
        try { result = JSON.parse(text); } catch (error) { throw failure('decrypt'); }
        if (!record(result) || result.ok !== true) throw failure('decrypt');
      }
      const durationSeconds = probeDuration(await run([executables.ffprobeExecutable, '-v', 'error', '-show_entries',
        'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', '-protocol_whitelist', 'file,pipe', '-i', processedPath], 'ignore', 'probe'));
      const decoded = await run([executables.ffmpegExecutable, '-v', 'error', '-xerror', '-err_detect', 'explode',
        '-protocol_whitelist', 'file,pipe', '-i', processedPath, '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-'], 'ignore', 'decode');
      if (decoded.trim()) throw failure('decode');
      active.throwIfAborted();
      return { processedPath, durationSeconds, fullDecodeChecked: true, validationLevel: 'ffprobe-full-decode-sha256' };
    } catch (error) {
      if (active.aborted) throw new DownloadError('cancelled', '视频处理已取消或超过时限；未完成文件已清理');
      if (error instanceof DownloadError) throw error;
      throw failure('runtime');
    } finally { clearTimeout(timer); }
  };
}
