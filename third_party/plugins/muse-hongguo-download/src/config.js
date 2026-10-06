/** Explicit deployment defaults and JSON configuration validation. */
import { isAbsolute } from 'node:path';

const ranges = {
  requestTimeoutMs: [100, 120000], downloadTimeoutMs: [100, 3600000], callTimeoutMs: [100, 86400000],
  maxResponseBytes: [1024, 33554432], maxEpisodeBytes: [1024, 8589934592], maxSeries: [1, 20],
  concurrency: [1, 8], retries: [0, 4],
  mediaProcessGraceMs: [1, 10000],
  retryDelayMs: [0, 60000],
  signerStartupTimeoutMs: [100, 600000], signerHeapMb: [256, 4096],
  signerPollIntervalMs: [1, 1000], signerPortAttempts: [1, 16],
  deviceBootstrapTimeoutMs: [100, 300000],
};
const defaults = {
  sourceMode: 'legacy', legacyAppDir: '', signServer: '', signTokenEnv: 'MUSE_HONGGUO_SIGN_TOKEN',
  pythonExecutable: '', ffmpegExecutable: '', ffprobeExecutable: '',
  javaExecutable: '', signerStartupTimeoutMs: 120000, signerHeapMb: 1024,
  signerPollIntervalMs: 25, signerPortAttempts: 4,
  bootstrapDevices: false, deviceBootstrapTimeoutMs: 30000,
  mediaUserAgent: 'Mozilla/5.0 (Linux; Android 12)',
  catalogPath: '', outputRoot: '', mediaHosts: ['*.qznovelvod.com', '*.douyinvod.com', '*.idouyinvod.com', '*.pkoplink.com', '*.bdcgslb.com', '*.vegslb.com', '*.jspcdn.cn', '*.qrstuvwxyzab.com'],
  mediaPorts: [443, 9305],
  requestTimeoutMs: 20000, downloadTimeoutMs: 600000, callTimeoutMs: 7200000,
  maxResponseBytes: 8388608, maxEpisodeBytes: 1073741824, maxSeries: 10, concurrency: 3, retries: 2,
  mediaProcessGraceMs: 1000,
  retryDelayMs: 1500,
};

/** Resolve all settings before calls; optional credentials are read only via their environment variable name. */
export function resolveConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('红果插件 config 必须是对象');
  const config = { ...defaults, mediaHosts: [...defaults.mediaHosts], mediaPorts: [...defaults.mediaPorts] };
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(defaults, key)) throw new TypeError(`未知红果插件配置字段：${key}`);
    if (Object.hasOwn(ranges, key)) {
      const range = ranges[key];
      if (!Number.isSafeInteger(entry) || entry < range[0] || entry > range[1]) throw new TypeError(`${key} 必须是 ${range[0]}–${range[1]} 的整数`);
    } else if (key === 'bootstrapDevices') {
      if (typeof entry !== 'boolean') throw new TypeError('bootstrapDevices 必须是布尔值');
    } else if (key === 'mediaHosts') {
      if (!Array.isArray(entry) || !entry.length || entry.length > 40 || entry.some(host => typeof host !== 'string'
        || !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host))) throw new TypeError('mediaHosts 必须是有效的 HTTPS 媒体域名列表');
    } else if (key === 'mediaPorts') {
      if (!Array.isArray(entry) || !entry.length || entry.length > 40 || new Set(entry).size !== entry.length
        || entry.some(port => !Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new TypeError('mediaPorts 必须是不重复的有效 HTTPS 媒体端口列表');
    } else if (typeof entry !== 'string') throw new TypeError(`${key} 必须是字符串`);
    config[key] = Array.isArray(entry) ? [...entry] : entry;
  }
  if (!['legacy', 'manifest', 'public'].includes(config.sourceMode)) throw new TypeError('sourceMode 必须是 legacy、manifest 或 public');
  if (!config.mediaUserAgent || config.mediaUserAgent.length > 1024 || /[\r\n\0]/.test(config.mediaUserAgent)) throw new TypeError('mediaUserAgent 必须是非空有效请求头值');
  for (const key of ['legacyAppDir', 'catalogPath', 'outputRoot', 'pythonExecutable', 'ffmpegExecutable', 'ffprobeExecutable', 'javaExecutable']) {
    if (config[key] && !isAbsolute(config[key])) throw new TypeError(`${key} 必须是绝对路径`);
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(config.signTokenEnv)) throw new TypeError('signTokenEnv 必须是环境变量名称');
  if (config.signServer) {
    let url;
    try { url = new URL(config.signServer); } catch (error) { throw new TypeError('signServer 地址无效'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
      || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new TypeError('signServer 必须是显式端口的 http://127.0.0.1 本地签名器地址');
  }
  return Object.freeze(config);
}
