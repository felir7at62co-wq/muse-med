/** Verified v2 runtime, original license channel, and one owned download queue. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { V2EngineClient } from './v2-engine.js';
import { readV2DeviceIdentity } from './v2-device.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const codes = {
  v2_runtime_invalid: '红果 v2 运行资源校验失败，请重新准备运行目录',
  v2_device_invalid: '红果 v2 设备状态无效，请检查原设备配置',
  v2_protocol: '红果 v2 引擎返回无效数据',
  v2_catalog_invalid: '红果 v2 剧集目录不完整',
  v2_license_refused: '红果 v2 原许可服务未允许下载此剧',
  v2_download_refused: '红果 v2 引擎未接受下载任务',
  v2_download_failed: '红果 v2 下载任务未完成',
  v2_output_invalid: '红果 v2 下载目录未通过校验',
  v2_cancelled: '红果 v2 操作已取消',
  v2_closed: '红果 v2 会话已关闭',
  v2_busy: '红果 v2 会话已有下载任务',
  v2_request_timeout: '红果 v2 操作超时',
  v2_shutdown: '红果 v2 引擎退出清理失败',
};
class SessionError extends Error {
  constructor(code) { super(codes[code] ?? '红果 v2 操作失败'); this.code = code; }
}
const fail = code => new SessionError(code);
const token = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);
const inside = (root, path) => path !== root && path.startsWith(root + sep);
const privateMode = info => process.platform === 'win32' || (info.mode & 0o077) === 0;

async function privateJson(path, limit, code) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || !privateMode(info) || info.size > limit) throw fail(code);
  return JSON.parse(await readFile(path, 'utf8'));
}
async function digest(path, entry) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes || await realpath(path) !== path) throw fail('v2_runtime_invalid');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (hash.digest('hex') !== entry.sha256) throw fail('v2_runtime_invalid');
}
function runtimePath(root, value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw fail('v2_runtime_invalid');
  const path = resolve(root, ...value.split('/'));
  if (!inside(root, path)) throw fail('v2_runtime_invalid');
  return path;
}
async function verifiedRuntime(root, limit) {
  if (!isAbsolute(root) || await realpath(root) !== root) throw fail('v2_runtime_invalid');
  const path = join(root, 'v2-runtime.json'), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw fail('v2_runtime_invalid');
  const bytes = await readFile(path), manifest = JSON.parse(bytes.toString('utf8'));
  if (!object(manifest) || manifest.version !== 1 || typeof manifest.engineVersion !== 'string' || !manifest.engineVersion
    || !Number.isSafeInteger(manifest.build) || manifest.build < 0 || typeof manifest.requiresRosetta !== 'boolean'
    || !Array.isArray(manifest.files) || !manifest.files.length || !Array.isArray(manifest.executables)) throw fail('v2_runtime_invalid');
  const listed = new Set();
  for (const entry of manifest.files) {
    if (!object(entry) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw fail('v2_runtime_invalid');
    const file = runtimePath(root, entry.path);
    if (listed.has(file)) throw fail('v2_runtime_invalid');
    listed.add(file); await digest(file, entry);
  }
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw fail('v2_runtime_invalid');
      if (entry.isDirectory()) await walk(file);
      else if (!entry.isFile() || file !== path && !listed.has(file)) throw fail('v2_runtime_invalid');
    }
  }
  await walk(root);
  const executableEntries = new Map();
  for (const entry of manifest.executables) {
    if (!object(entry) || typeof entry.path !== 'string' || !isAbsolute(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || executableEntries.has(entry.path)) throw fail('v2_runtime_invalid');
    executableEntries.set(entry.path, entry); await digest(entry.path, entry);
  }
  for (const key of ['javaExecutable', 'dotnetExecutable']) {
    if (typeof manifest[key] !== 'string' || !executableEntries.has(manifest[key])) throw fail('v2_runtime_invalid');
  }
  const paths = {};
  for (const key of ['hostJar', 'brokerDll', 'engineLibDir', 'signerDir', 'jnaDir']) {
    paths[key] = runtimePath(root, manifest[key]);
    const item = await lstat(paths[key]);
    if (item.isSymbolicLink() || (key.endsWith('Dir') ? !item.isDirectory() : !listed.has(paths[key]))) throw fail('v2_runtime_invalid');
  }
  return { manifest, paths, identity: createHash('sha256').update(bytes).digest('hex') };
}
function properties(value) {
  return Object.entries(value).map(([key, entry]) => `${key}=${String(entry).replaceAll('\\', '\\\\').replaceAll('\r', '\\r').replaceAll('\n', '\\n')}`).join('\n') + '\n';
}
// DownloadEngineKt.cleanName, for the first series in a new private output root.
function sourceFolderName(title, id) {
  const whitespace = '[\\u0009-\\u000d\\u001c-\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
  const trim = value => value.replace(new RegExp(`^${whitespace}+|${whitespace}+$`, 'g'), '');
  const clean = value => {
    let result = trim(value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[ \t\n\v\f\r]+/g, ' ')).slice(0, 120).replace(/[. ]+$/, '');
    if (/^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)$/i.test(trim(result.split('.')[0]))) result = '_' + result;
    return result;
  };
  return clean(title) || clean(id) || 'series';
}
async function outputDirectories(root) {
  const directories = new Set();
  async function visit(path) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw fail('v2_output_invalid');
    directories.add(path);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw fail('v2_output_invalid');
      if (entry.isDirectory()) await visit(join(path, entry.name));
    }
  }
  await visit(root);
  return directories;
}
async function checkedOutputFolder(root, folder, previous) {
  if (typeof folder !== 'string' || !isAbsolute(folder) || resolve(folder) !== folder
    || !inside(root, folder) || previous.has(folder)) throw fail('v2_output_invalid');
  let current = root;
  for (const part of ['', ...relative(root, folder).split(sep)]) {
    if (part) current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw fail('v2_output_invalid');
  }
  return folder;
}

/** Owns verified runtime processes; no source or license fallback is performed. */
export class V2Session {
  /**
   * @param {object} subprocess Managed subprocess provider.
   * @param {object} config Resolved v2 runtime, state, timing, concurrency, and media settings.
   * @param {object} paths Caller-confined runDir and private source outputDir.
   * @param {object} [dependencies] Optional readDeviceIdentity collector; omission uses the real managed physical-device reader.
   */
  constructor(subprocess, config, { runDir, outputDir }, dependencies = {}) {
    this.subprocess = subprocess; this.config = config;
    this.readDeviceIdentity = dependencies.readDeviceIdentity ?? readV2DeviceIdentity;
    this.runDir = resolve(runDir); this.outputDir = resolve(outputDir);
    this.stop = new AbortController(); this.callbacks = new Set();
    this.startTask = null; this.disposeTask = null; this.cleanupTask = null;
    this.downloading = false; this.downloadStarted = false;
    this.sourceIdentity = null; this.engine = null; this.broker = null;
  }

  /**
   * Verify runtime and stable device state, then start both peers without a license-server request.
   * @param {AbortSignal} [signal] Aborting closes this entire owned session; omission uses configured startup limits.
   * @returns {Promise<void>} Resolves after both protocol handshakes.
   */
  async start(signal) {
    if (this.disposeTask) throw fail('v2_closed');
    if (signal?.aborted) throw fail('v2_cancelled');
    if (!this.startTask) this.startTask = this.setup();
    return this.operation(() => this.startTask, signal);
  }

  async setup() {
    try {
      if (this.stop.signal.aborted) throw fail('v2_cancelled');
      const { manifest, paths, identity } = await verifiedRuntime(this.config.v2RuntimeDir, this.config.maxResponseBytes);
      if (this.stop.signal.aborted) throw fail('v2_cancelled');
      const ffmpeg = manifest.executables.filter(entry => entry.name === 'ffmpeg');
      if (ffmpeg.length !== 1) throw fail('v2_runtime_invalid');
      await digest(this.config.ffmpegExecutable, ffmpeg[0]);
      const state = resolve(this.config.v2StateDir), stateInfo = await lstat(state);
      if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || !privateMode(stateInfo) || await realpath(state) !== state) throw fail('v2_device_invalid');
      const deviceFile = join(state, 'device.json');
      const device = await privateJson(deviceFile, this.config.maxResponseBytes, 'v2_device_invalid');
      if (!object(device) || device.version !== 1 || device.platform !== process.platform
        || typeof device.deviceId !== 'string' || !/^d1:[a-f0-9]{32}$/.test(device.deviceId)) throw fail('v2_device_invalid');
      const physicalIdentity = await this.readDeviceIdentity(this.subprocess, this.config, this.stop.signal);
      if (physicalIdentity !== device.deviceId) throw fail('v2_device_invalid');
      for (const directory of [this.runDir, this.outputDir]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw fail('v2_output_invalid');
      }
      if (!inside(this.runDir, this.outputDir)) throw fail('v2_output_invalid');
      const privateRoot = await mkdtemp(join(this.runDir, 'v2-session-'));
      const home = join(privateRoot, 'home'), appData = join(privateRoot, 'appdata'), tempDir = join(privateRoot, 'tmp');
      for (const directory of [home, appData, tempDir]) await mkdir(directory, { mode: 0o700 });
      const hostConfig = join(privateRoot, 'host.properties'), brokerConfig = join(privateRoot, 'broker.json');
      await writeFile(hostConfig, properties({ deviceFile, privateRoot: this.runDir, outputRoot: this.outputDir,
        queueFile: join(privateRoot, 'queue.json'), userHome: home, appData, tempDir,
        signerDir: paths.signerDir, ffmpeg: this.config.ffmpegExecutable, seriesAtOnce: 1,
        episodesAtOnce: this.config.v2EpisodesAtOnce, connectionsPerFile: this.config.v2ConnectionsPerFile,
        maxEpisodesPerJob: this.config.v2MaxEpisodesPerJob, quality: this.config.v2Quality, networkStorage: false }), { flag: 'wx', mode: 0o600 });
      await writeFile(brokerConfig, JSON.stringify({ deviceFile, stateDirectory: join(state, 'license'), appVersion: '2.0.0',
        maxLineBytes: this.config.v2MaxLineBytes, maxPendingRequests: this.config.v2MaxPendingRequests }) + '\n', { flag: 'wx', mode: 0o600 });
      if (this.stop.signal.aborted) throw fail('v2_cancelled');
      const windows = process.platform === 'win32';
      const env = { LANG: 'en_US.UTF-8', APPDATA: appData, LOCALAPPDATA: appData,
        TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir,
        PATH: windows ? [dirname(manifest.javaExecutable), dirname(manifest.dotnetExecutable), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(delimiter) : '/usr/bin:/bin:/usr/sbin:/sbin' };
      if (windows) env.SystemRoot = process.env.SystemRoot || 'C:\\Windows';
      const base = { cwd: privateRoot, startupTimeoutMs: this.config.v2StartupTimeoutMs,
        requestTimeoutMs: this.config.v2RequestTimeoutMs, shutdownTimeoutMs: this.config.v2ShutdownTimeoutMs,
        maxLineBytes: this.config.v2MaxLineBytes, maxPendingRequests: this.config.v2MaxPendingRequests,
        processGraceMs: this.config.mediaProcessGraceMs, clientVersion: 'Muse' };
      this.engine = new V2EngineClient(this.subprocess, { ...base, env, argv: [manifest.javaExecutable,
        '-Xlog:disable', '-Xlog:all=warning:stderr', '-XX:+DisableAttachMechanism',
        '-Dhongguo.signer.dir=' + paths.signerDir, '-Dhongguo.ffmpeg=' + this.config.ffmpegExecutable,
        '-Djna.boot.library.path=' + paths.jnaDir, '-Djna.nosys=true', '-Djna.nounpack=true', '-Dfile.encoding=UTF-8',
        '-Duser.home=' + home, '-Djava.io.tmpdir=' + tempDir, '-cp', paths.hostJar + delimiter + join(paths.engineLibDir, '*'),
        'muse.hongguo.v2.PortableHost', hostConfig] });
      const hello = await this.engine.start(this.stop.signal);
      if (hello.engineVersion !== manifest.engineVersion || hello.build !== manifest.build) throw fail('v2_protocol');
      if (this.stop.signal.aborted) throw fail('v2_cancelled');
      if (manifest.requiresRosetta && process.platform !== 'darwin') throw fail('v2_runtime_invalid');
      const brokerArgv = [manifest.dotnetExecutable, paths.brokerDll, '--config', brokerConfig];
      if (manifest.requiresRosetta) brokerArgv.unshift('/usr/bin/arch', '-x86_64');
      this.broker = new V2EngineClient(this.subprocess, { ...base, argv: brokerArgv, env: { ...env,
        DOTNET_ROOT: dirname(manifest.dotnetExecutable), DOTNET_CLI_HOME: home,
        DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_MULTILEVEL_LOOKUP: '0',
        DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_ReadyToRun: '0', COMPlus_ReadyToRun: '0', DOTNET_EnableDiagnostics: '0' } },
      (method, params) => { if (method === 'license.channel') this.proof(params); });
      await this.broker.start(this.stop.signal);
      this.sourceIdentity = identity;
    } catch (error) {
      await this.cleanupPeers();
      if (error instanceof SessionError) throw error;
      if (error && token(error.code) && error.code.startsWith('v2_')) throw fail(error.code);
      throw fail('v2_runtime_invalid');
    }
  }

  proof(params) {
    if (!object(params) || typeof params.callbackId !== 'string' || !params.callbackId
      || !['license.challenge', 'license.prove', 'license.clear', 'license.set'].includes(params.method)
      || !object(params.params)) throw fail('v2_protocol');
    const task = (async () => {
      let response;
      try { response = { result: await this.engine.request(params.method, params.params, this.stop.signal) }; }
      catch (error) { response = { error: { code: 'helper_rejected' } }; }
      await this.broker.request('proof_response', { callbackId: params.callbackId, ...response }, this.stop.signal);
    })();
    this.callbacks.add(task);
    void task.catch(() => { this.stop.abort(); void this.dispose().catch(() => {}); }).finally(() => this.callbacks.delete(task));
  }

  async operation(action, signal) {
    let cancelled = false;
    const abort = () => { cancelled = true; this.stop.abort(); void this.dispose().catch(() => {}); };
    if (signal?.aborted || this.stop.signal.aborted) throw fail('v2_cancelled');
    if (signal) signal.addEventListener('abort', abort, { once: true });
    try { return await action(); }
    catch (error) {
      if (cancelled || signal?.aborted || error?.code === 'v2_cancelled') { await this.dispose(); throw fail('v2_cancelled'); }
      if (error instanceof SessionError) throw error;
      if (error && token(error.code) && error.code.startsWith('v2_')) throw fail(error.code);
      throw fail('v2_protocol');
    } finally { if (signal) signal.removeEventListener('abort', abort); }
  }

  /**
   * Inspect verified startup facts and the original SDK's unrefreshed local status.
   * @param {AbortSignal} [signal] Aborting closes the session; omission uses configured startup and request deadlines.
   * @returns {Promise<object>} Whitelisted local facts; no server authorization or media test is performed.
   */
  async health(signal) {
    await this.start(signal);
    return this.operation(async () => {
      const status = await this.broker.request('local_status', {}, this.stop.signal);
      if (!object(status) || !['Checking', 'Licensed', 'Grace', 'Unlicensed'].includes(status.mode)
        || !token(status.reason)) throw fail('v2_protocol');
      const hello = this.engine.hello;
      if (typeof hello.engineVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(hello.engineVersion)) throw fail('v2_protocol');
      return { sourceIdentity: this.sourceIdentity,
        engine: { engineVersion: hello.engineVersion, protocol: hello.protocol, build: hello.build },
        localLicenseStatus: { mode: status.mode, reason: status.reason, refreshed: false } };
    }, signal);
  }

  /**
   * Read the exact declared episode list without checking or consuming a series license.
   * @param {string} id Exact series ID.
   * @param {AbortSignal} [signal] Aborting closes the session; omission uses the request deadline.
   * @returns {Promise<object>} Normalized complete catalog; no media availability claim.
   */
  async catalog(id, signal) {
    await this.start(signal);
    return this.operation(async () => {
      const detail = await this.engine.request('series.detail', { id }, this.stop.signal);
      if (!object(detail) || detail.id !== id || typeof detail.title !== 'string' || !detail.title.trim()
        || !Array.isArray(detail.episodes) || !detail.episodes.length || detail.episodes.some((episode, index) => !object(episode)
          || episode.number !== index + 1 || episode.durationSec !== null && episode.durationSec !== undefined
          && (typeof episode.durationSec !== 'number' || !Number.isFinite(episode.durationSec) || episode.durationSec <= 0))) throw fail('v2_catalog_invalid');
      return { seriesId: id, title: detail.title, episodeCount: detail.episodes.length, source: 'hongguo-v2',
        episodes: detail.episodes.map(episode => ({ index: episode.number, vid: `${id}:${episode.number}`,
          title: `第 ${episode.number} 集`, durationSeconds: episode.durationSec ?? null })) };
    }, signal);
  }

  /**
   * Obtain original server permission, then await one exact episode selection's terminal queue result.
   * @param {string} id Exact series ID.
   * @param {string} title Catalog title used by the original output naming method.
   * @param {number[]} episodes Exact requested positive episode numbers.
   * @param {string} quality Explicit original engine quality name.
   * @param {AbortSignal} [signal] Aborting stops both peers; omission retains configured call and request deadlines.
   * @returns {Promise<object>} Terminal successful job and checked source folder; files still need independent decoding and hashing.
   */
  async download(id, title, episodes, quality, signal) {
    await this.start(signal);
    if (this.downloading) throw fail('v2_busy');
    this.downloading = true;
    const timeout = AbortSignal.timeout(this.config.callTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.operation(async () => {
        if (typeof title !== 'string' || !title || !Array.isArray(episodes) || !episodes.length
          || episodes.length > this.config.v2MaxEpisodesPerJob
          || episodes.some(value => !Number.isSafeInteger(value) || value < 1) || new Set(episodes).size !== episodes.length
          || typeof quality !== 'string' || !quality) throw fail('v2_download_refused');
        const previousFolders = await outputDirectories(this.outputDir);
        const refreshed = await this.broker.request('refresh', {}, this.stop.signal);
        if (!object(refreshed) || typeof refreshed.licensed !== 'boolean') throw fail('v2_protocol');
        const helper = await this.engine.request('license.status', {}, this.stop.signal);
        if (!object(helper) || typeof helper.state !== 'string') throw fail('v2_protocol');
        // The original LicenseCourier.ProveAfterStartAsync owns this initial free-mode transition.
        if (!refreshed.licensed && !['licensed', 'grace'].includes(helper.state))
          await this.engine.request('license.set', { mode: 'free' }, this.stop.signal);
        const decision = await this.broker.request('check_series', { seriesId: id }, this.stop.signal);
        if (!object(decision) || typeof decision.allowed !== 'boolean') throw fail('v2_protocol');
        if (!decision.allowed) {
          const error = fail('v2_license_refused');
          if (token(decision.reason)) error.safeReason = decision.reason;
          for (const key of ['freeUsed', 'freeLimit']) if (Number.isSafeInteger(decision[key]) && decision[key] >= 0) error[key] = decision[key];
          throw error;
        }
        const candidate = join(this.outputDir, sourceFolderName(title, id));
        const added = await this.engine.request('downloads.add', { requests: [{ seriesId: id, title, quality, episodes }] }, this.stop.signal);
        if (!object(added) || !Array.isArray(added.added) || !added.added.includes(id)) throw fail('v2_download_refused');
        this.downloadStarted = true;
        for (;;) {
          const snapshot = await this.engine.request('downloads.snapshot', {}, this.stop.signal);
          if (!object(snapshot) || !Array.isArray(snapshot.jobs)) throw fail('v2_protocol');
          const matches = snapshot.jobs.filter(job => object(job) && job.seriesId === id);
          if (matches.length > 1) throw fail('v2_protocol');
          const job = matches[0];
          if (job && ['done', 'failed', 'canceled'].includes(job.state)) {
            if (job.state !== 'done' || job.done !== episodes.length || job.episodes !== episodes.length || job.failed !== 0) throw fail('v2_download_failed');
            const folder = own(job, 'folder') && job.folder !== null ? job.folder : candidate;
            await checkedOutputFolder(this.outputDir, folder, previousFolders);
            return { job: { state: job.state, done: job.done, episodes: job.episodes, failed: job.failed,
              errorCode: token(job.errorCode) ? job.errorCode : null }, folder };
          }
          await delay(this.config.v2PollIntervalMs, undefined, { signal: this.stop.signal });
        }
      }, combined);
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) throw fail('v2_request_timeout');
      throw error;
    } finally { this.downloading = false; }
  }

  /** Stop queue work and await both peers; a failed join rejects and leaves caller-owned files intact. @returns {Promise<void>} Shared cleanup completion. */
  dispose() {
    if (!this.disposeTask) {
      this.stop.abort();
      const cleanup = this.cleanupPeers();
      this.disposeTask = (async () => {
        // setup() uses cleanupPeers directly, so joining startup here cannot wait on itself.
        const outcomes = await Promise.allSettled([cleanup, ...(this.startTask ? [this.startTask] : [])]);
        if (outcomes[0].status === 'rejected') throw fail('v2_shutdown');
      })();
    }
    return this.disposeTask;
  }

  cleanupPeers() {
    if (!this.cleanupTask) this.cleanupTask = (async () => {
      this.stop.abort();
      if (this.downloadStarted && this.engine) {
        try { await this.engine.request('downloads.cancelAll', {}, AbortSignal.timeout(this.config.v2ShutdownTimeoutMs)); }
        catch (error) { /* Process disposal below remains the authoritative stop. */ }
      }
      const peers = [this.broker, this.engine].filter(Boolean);
      const outcomes = await Promise.allSettled(peers.map(peer => peer.dispose()));
      await Promise.allSettled([...this.callbacks]);
      if (outcomes.some(outcome => outcome.status === 'rejected')) throw fail('v2_shutdown');
    })();
    return this.cleanupTask;
  }

  /** Alias for awaited disposal. @returns {Promise<void>} Shared cleanup completion. */
  close() { return this.dispose(); }
}
