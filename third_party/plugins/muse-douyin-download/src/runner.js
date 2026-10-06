/** Managed Python execution with bounded output and cancellation settlement. */
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../python/scripts/download.py', import.meta.url))
  .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2');
const fields = new Set(['pythonExecutable', 'ffprobeExecutable', 'ffmpegExecutable', 'settingsHome', 'requestTimeoutMs', 'timeoutMs', 'maxDownloadBytes', 'graceMs', 'maxVideos']);

/** Validate deployment settings before registering tools. @param {object} config Settings. @returns {object} Explicit subprocess settings. */
export function resolveConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('Douyin configuration must be an object');
  for (const field of Object.keys(config)) if (!fields.has(field)) throw new TypeError(`Unknown Douyin setting: ${field}`);
  const result = {
    pythonExecutable: process.env.MUSE_DOUYIN_PYTHON_PATH || null,
    ffprobeExecutable: process.env.DSH_FFPROBE_PATH || process.env.FFPROBE_PATH || null,
    ffmpegExecutable: process.env.DSH_FFMPEG_PATH || process.env.FFMPEG_PATH || null,
    settingsHome: process.env.DSH_HOME || process.env.MUSE_HOME || null,
    requestTimeoutMs: 30000, timeoutMs: 120000, maxDownloadBytes: 100 * 1024 ** 2, graceMs: 1000, maxVideos: 20,
    ...config,
  };
  for (const field of ['pythonExecutable', 'ffprobeExecutable', 'ffmpegExecutable']) {
    if (result[field] !== null && (typeof result[field] !== 'string' || !result[field].trim() || result[field].includes('\0'))) throw new TypeError(`${field} must name an executable or be null`);
  }
  if (result.settingsHome !== null && (typeof result.settingsHome !== 'string' || !isAbsolute(result.settingsHome))) throw new TypeError('settingsHome must be Muse’s absolute settings directory');
  for (const [field, min, max] of [['requestTimeoutMs', 1000, 300000], ['timeoutMs', 1000, 7200000], ['maxDownloadBytes', 1, 8 * 1024 ** 3], ['graceMs', 0, 10000], ['maxVideos', 1, 100]]) {
    if (!Number.isSafeInteger(result[field]) || result[field] < min || result[field] > max) throw new TypeError(`${field} must be an integer from ${min} to ${max}`);
  }
  return result;
}

/** Report missing runtime settings before any network or credential access. @param {object} config Resolved settings. @returns {object|null} Blocked diagnostic, or null when all executables are selected. */
export function runtimeUnavailable(config) {
  const missing = ['pythonExecutable', 'ffprobeExecutable', 'ffmpegExecutable'].filter(field => config[field] === null);
  return missing.length ? { status: 'blocked', code: 'RUNTIME_UNAVAILABLE', message: `RUNTIME_UNAVAILABLE: configure ${missing.join(', ')} from the bundled runtime or explicit deployment paths` } : null;
}

/** Build argv without a shell; credentials are local paths, never cookie contents. @param {object} config Resolved settings. @param {object} args Validated tool input. @param {string} workspace Current session directory. @returns {string[]} Python command. */
export function downloadCommand(config, args, workspace) {
  const unavailable = runtimeUnavailable(config);
  if (unavailable) throw new Error(unavailable.message);
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) throw new Error('Douyin download requires a session with an absolute workspace directory');
  if (!config.settingsHome && args.publicOnly !== true) throw new Error('Set settingsHome to Muse’s own settings directory, or explicitly choose publicOnly');
  const argv = [config.pythonExecutable, '-I', '-B', script, '--url', args.url, '--project', workspace,
    '--ffprobe', config.ffprobeExecutable, '--ffmpeg', config.ffmpegExecutable,
    '--request-timeout', String(Math.ceil(config.requestTimeoutMs / 1000)), '--max-bytes', String(config.maxDownloadBytes)];
  if (config.settingsHome) argv.push('--settings-home', config.settingsHome);
  for (const [key, flag] of [['cookieFile', '--cookie-file'], ['browser', '--browser'], ['browserProfile', '--browser-profile']]) if (args[key] !== undefined) argv.push(flag, args[key]);
  if (args.rememberBrowser) argv.push('--remember-browser');
  if (args.publicOnly) argv.push('--public-only');
  return argv;
}

/** Await process exit before exposing a bounded result; discard stderr and signed upstream URLs. @param {object} subprocess Host subprocess service. @param {object} config Resolved settings. @param {string[]} argv Python command. @param {string} workspace Session directory. @param {AbortSignal} signal Tool cancellation. @returns {Promise<object>} Validated downloader receipt or blocked diagnostic. */
export async function runDownloader(subprocess, config, argv, workspace, signal) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('Douyin download timed out')), config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    combined.throwIfAborted();
    const handle = subprocess.spawn({ argv, cwd: workspace, env: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/KEY|SECRET|TOKEN|PASSWORD|COOKIE|PROXY|PYTHON|NODE_OPTIONS|SSL_CERT/i.test(key))), stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }, graceMs: config.graceMs, signal: combined });
    const outcome = await handle.done;
    await handle.waitForExit?.();
    combined.throwIfAborted();
    if (outcome.signal) throw new Error('Douyin downloader terminated before completion');
    const output = handle.collected.stdout?.readFrom(0);
    if (!output || output.lossy || output.truncated) throw new Error('Douyin downloader returned incomplete output');
    let result;
    try { result = JSON.parse(output.text); } catch (error) { throw new Error('Douyin downloader returned invalid JSON'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Douyin downloader returned invalid result fields');
    if (result.status === 'blocked' && outcome.exitCode === 1 && typeof result.message === 'string' && result.message.length <= 2048) return result;
    if (outcome.exitCode !== 0 || result.status !== 'downloaded' || result.full_decode_verified !== true
      || !isAbsolute(result.path || '') || !isAbsolute(result.receipt || '') || !/^https:\/\/www\.douyin\.com\/video\/\d{10,25}$/.test(result.source || '')
      || !/^[a-f0-9]{64}$/.test(result.sha256 || '') || !Number.isSafeInteger(result.bytes) || result.bytes <= 0
      || typeof result.duration_seconds !== 'number' || !Number.isFinite(result.duration_seconds) || result.duration_seconds <= 0) throw new Error('Douyin downloader did not return a verified video receipt');
    const expected = join(workspace, 'source', 'media', 'douyin');
    if (relative(expected, result.path).startsWith('..') || isAbsolute(relative(expected, result.path))
      || result.receipt !== result.path + '.source.json') throw new Error('Douyin receipt points outside the session download directory');
    return result;
  } finally { clearTimeout(timer); }
}
