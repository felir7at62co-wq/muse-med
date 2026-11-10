/** Publish independently verified v2 engine files with a separate, resumable v2 journal. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { validateMp4 } from './media.js';
import { verifiedEpisode } from './checkpoint.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root, path) => { const part = relative(root, path); return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };
const filename = index => `S01E${String(index).padStart(3, '0')}.mp4`;
const messages = {
  invalid_arguments: '红果 v2 下载参数无效',
  cancelled: '红果 v2 下载已取消或超过时限；已验证的集保留',
  download_in_progress: '同一红果 v2 下载正在执行，请等待原任务',
  unsafe_path: '红果 v2 文件路径包含链接、越界或已被替换',
  output_exists: '红果 v2 目标文件已存在且没有匹配的有效收据，未覆盖文件',
  invalid_media: '红果 v2 文件未通过完整 MP4 和解码验证',
  missing_media_runtime: '缺少红果 v2 文件完整解码验证运行时',
  media_size: '红果 v2 文件大小无效或超过配置限制',
  v2_runtime_invalid: '红果 v2 运行时身份未通过校验',
  v2_device_invalid: '红果 v2 本机设备状态无效',
  v2_protocol: '红果 v2 引擎协议响应无效',
  v2_catalog_invalid: '红果 v2 目录不完整或与请求不匹配',
  v2_checkpoint_invalid: '红果 v2 进度记录无效或来源已改变，原记录已保留',
  v2_license_refused: '红果 v2 正常授权检查拒绝了请求',
  v2_download_refused: '红果 v2 引擎拒绝了下载请求',
  v2_download_failed: '红果 v2 引擎未完成全部请求集',
  v2_output_invalid: '红果 v2 引擎输出目录或文件无效',
  v2_shutdown: '红果 v2 引擎退出未确认，私有临时文件已保留',
  v2_request_timeout: '红果 v2 请求超时',
  v2_start_timeout: '红果 v2 启动超时',
  v2_io: '红果 v2 引擎通信失败',
  v2_protocol_version: '红果 v2 协议版本不匹配',
  v2_line_size: '红果 v2 协议消息超过配置限制',
  v2_capacity: '红果 v2 待处理请求达到配置限制',
  v2_remote_error: '红果 v2 引擎返回错误',
  v2_closed: '红果 v2 引擎已关闭',
  v2_eof: '红果 v2 引擎输出已关闭',
  v2_notification: '红果 v2 引擎通知处理失败',
  v2_request_json: '红果 v2 请求无法编码',
  operation_failed: '红果 v2 文件操作失败；已验证的集保留',
};
class V2DownloadError extends Error {
  constructor(code) { super(messages[code]); this.code = code; }
}
const fail = code => { throw new V2DownloadError(code); };
function safeFailure(error, signal) {
  const code = signal.aborted || ['v2_cancelled', 'cancelled'].includes(error?.code) ? 'cancelled'
    : Object.hasOwn(messages, error?.code) ? error.code : error?.code === 'encrypted_media' ? 'invalid_media' : 'operation_failed';
  const value = { code, message: messages[code] };
  if (code === 'v2_license_refused') {
    if (typeof error.safeReason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.safeReason)) value.safeReason = error.safeReason;
    for (const key of ['freeUsed', 'freeLimit']) if (Number.isSafeInteger(error[key]) && error[key] >= 0) value[key] = error[key];
  }
  return value;
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

async function directory(path, create = false) {
  if (!isAbsolute(path) || resolve(path) !== path) fail('unsafe_path');
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe_path');
  }
  if (await realpath(path) !== path) fail('unsafe_path');
  return lstat(path);
}
async function regularFile(root, path) {
  if (!inside(root, path)) fail('unsafe_path');
  await directory(dirname(path));
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) fail('unsafe_path');
  return info;
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail('output_exists');
}
async function jsonFile(root, path, maximum) {
  let info;
  try { info = await regularFile(root, path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (info.size > maximum) fail('v2_checkpoint_invalid');
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error instanceof SyntaxError) fail('v2_checkpoint_invalid'); throw error; }
}
function catalogFor(catalog, id) {
  if (!object(catalog) || catalog.seriesId !== id || typeof catalog.title !== 'string'
    || !Number.isSafeInteger(catalog.episodeCount) || catalog.episodeCount < 1 || !Array.isArray(catalog.episodes)
    || catalog.episodes.length !== catalog.episodeCount || catalog.episodes.some((episode, offset) => !object(episode)
      || episode.index !== offset + 1 || typeof episode.vid !== 'string' || !episode.vid)
    || new Set(catalog.episodes.map(episode => episode.vid)).size !== catalog.episodeCount) fail('v2_catalog_invalid');
  return { seriesId: id, title: catalog.title, episodeCount: catalog.episodeCount, source: 'hongguo-v2',
    episodes: catalog.episodes.map(episode => ({ index: episode.index, vid: episode.vid,
      title: String(episode.title ?? `第 ${episode.index} 集`), durationSeconds: episode.durationSeconds ?? null })) };
}
function catalogKey(rows) {
  if (!Array.isArray(rows) || rows.some(row => !object(row) || typeof row.seriesId !== 'string'
    || !Number.isSafeInteger(row.episodeCount) || !Array.isArray(row.episodes)
    || row.episodes.some(episode => !object(episode) || typeof episode.vid !== 'string'))) return null;
  return JSON.stringify(rows.map(row => [row.seriesId, row.episodeCount, row.episodes.map(episode => episode.vid)]));
}
async function digest(path, maximum, signal) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum) fail('media_size');
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: true })) {
      signal.throwIfAborted(); bytes += chunk.length;
      if (bytes > maximum) fail('media_size');
      hash.update(chunk);
    }
    if (!sameFile(before, await lstat(path)) || bytes !== before.size) fail('invalid_media');
    return { bytes, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
async function copyOwned(source, part, before, signal) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output, completed = false, bytes = 0;
  try {
    if (!sameFile(before, await input.stat())) fail('unsafe_path');
    output = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const bounded = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > before.size ? new V2DownloadError('invalid_media') : null, chunk);
    } });
    await pipeline(input.createReadStream({ autoClose: true }), bounded, output.createWriteStream({ autoClose: true }), { signal });
    if (!sameFile(before, await lstat(source))) fail('invalid_media');
    completed = true;
  } finally {
    await Promise.allSettled([input.close(), output?.close()]);
    if (output && !completed) await rm(part, { force: true });
  }
}

/** Own isolated v2 sessions; only independently validated local MP4 files reach v2 receipts. */
export class V2DownloadClient {
  /**
   * @param {object} config Resolved limits, v2 runtime/state directories and explicit quality.
   * @param {object} dependencies Managed subprocess, media validator and optional test session factory.
   */
  constructor(config, { subprocess, processMedia, sessionFactory } = {}) {
    this.config = config;
    this.subprocess = subprocess;
    this.processMedia = processMedia;
    this.sessionFactory = sessionFactory ?? (async (...args) => { const { V2Session } = await import('./v2-session.js'); return new V2Session(...args); });
    this.lifetime = new AbortController();
    this.pending = new Set();
    this.cleanupError = null;
    this.disposeTask = null;
  }

  async withSession(signal, operation) {
    signal.throwIfAborted();
    const runDir = await realpath(await mkdtemp(join(tmpdir(), 'muse-hongguo-v2-'))), outputDir = join(runDir, 'output');
    await mkdir(outputDir, { mode: 0o700 });
    let session, closed = true, closeTask;
    const close = async () => {
      if (!session || closed) return;
      closeTask ??= Promise.resolve().then(() => session.dispose());
      await closeTask; closed = true;
    };
    try {
      signal.throwIfAborted();
      session = await this.sessionFactory(this.subprocess, this.config, { runDir, outputDir });
      closed = false;
      await session.start(signal);
      if (!/^[a-f0-9]{64}$/.test(session.sourceIdentity)) fail('v2_runtime_invalid');
      return await operation(session, { runDir, outputDir, close });
    } finally {
      try { await close(); }
      catch (error) { this.cleanupError ??= new V2DownloadError('v2_shutdown'); throw this.cleanupError; }
      finally { if (closed) await rm(runDir, { recursive: true, force: true }); }
    }
  }

  run(signal, operation) {
    const active = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(this.config.callTimeoutMs)]);
    const work = (async () => {
      try { active.throwIfAborted(); return await operation(active); }
      catch (error) { return { ok: false, complete: false, sourceBackend: 'v2', ...safeFailure(error, active) }; }
    })();
    this.pending.add(work); void work.then(() => this.pending.delete(work));
    return work;
  }

  /**
   * Inspect complete catalogs without treating them as download or authorization proof.
   * @param {object} options Validated seriesIds and legacy source mode.
   * @param {AbortSignal} [signal] Optional caller cancellation.
   * @returns {Promise<object>} Source-free catalog facts or a fixed failure.
   */
  info(options, signal) {
    return this.run(signal, active => this.withSession(active, async session => {
      const items = [];
      for (const id of options.seriesIds) {
        const catalog = catalogFor(await session.catalog(id, active), id);
        items.push({ seriesId: id, title: catalog.title, source: catalog.source, episodeCount: catalog.episodeCount,
          accessibleEpisodeCount: null, completeCatalog: true, downloaded: false, mediaUrlsVerified: false, fullSeriesAvailable: null });
      }
      return { ok: true, sourceMode: 'legacy', sourceBackend: 'v2', sourceIdentity: session.sourceIdentity, items,
        verifiedDownload: false, note: 'v2 目录完整不代表媒体可下载；只有真实文件通过完整解码后才验证下载。' };
    }));
  }

  async publishFile(source, target, paths, active) {
    const sourceInfo = await regularFile(paths.outputDir, source);
    if (sourceInfo.size < 1 || sourceInfo.size > this.config.maxEpisodeBytes) fail('media_size');
    await absent(target);
    const part = `${target}.part`;
    let copied = false;
    try {
      await copyOwned(source, part, sourceInfo, active); copied = true;
      await validateMp4(part);
      const beforeDecode = await digest(part, this.config.maxEpisodeBytes, active);
      const validation = await this.processMedia({ encryption: null }, { inputPath: part,
        outputPath: join(paths.runDir, 'validated.mp4'), workspace: paths.runDir, signal: active });
      if (validation.processedPath !== part || validation.fullDecodeChecked !== true
        || validation.validationLevel !== 'ffprobe-full-decode-sha256'
        || !Number.isFinite(validation.durationSeconds) || validation.durationSeconds <= 0) fail('invalid_media');
      await validateMp4(part);
      const facts = await digest(part, this.config.maxEpisodeBytes, active);
      if (facts.bytes !== beforeDecode.bytes || facts.sha256 !== beforeDecode.sha256) fail('invalid_media');
      if (!sameFile(sourceInfo, await regularFile(paths.outputDir, source))) fail('invalid_media');
      await directory(dirname(target)); await absent(target); active.throwIfAborted();
      await rename(part, target); copied = false;
      return { ...facts, durationSeconds: validation.durationSeconds, sourceBytes: null, sourceSha256: null,
        encryptedSource: null, origin: 'engine-output', format: 'mp4', validationLevel: 'ffprobe-full-decode-sha256', fullDecodeChecked: true };
    } finally { if (copied) await rm(part, { force: true }); }
  }

  /**
   * Download validated options into an already-authorized absolute output directory.
   * @param {object} options Normalized seriesIds/mode/episodes and canonical absolute outputDir.
   * @param {AbortSignal} [signal] Optional caller cancellation.
   * @param {string} [_workspace] The parent client owns workspace authorization before this call.
   * @param {object} [_filePolicy] The parent client owns file-policy validation before this call.
   * @returns {Promise<object>} Independently verified v2 receipt, or failure with retained progress.
   */
  download(options, signal, _workspace, _filePolicy) {
    let progress = null;
    return this.run(signal, async active => {
      try {
        return await this.withSession(active, async (session, paths) => {
          if (typeof this.processMedia !== 'function') fail('missing_media_runtime');
          const root = options.outputDir;
          const rootIdentity = await directory(root, true);
          const request = { backend: 'v2', sourceIdentity: session.sourceIdentity, mode: 'legacy',
            seriesIds: options.seriesIds, episodes: options.episodes, quality: this.config.v2Quality };
          const key = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 32);
          const targetDir = join(root, `hongguo-v2-${key}`), checkpoint = join(targetDir, 'resume-state.json');
          await directory(targetDir, true);
          const checkRoot = async () => { const now = await directory(root); if (now.dev !== rootIdentity.dev || now.ino !== rootIdentity.ino) fail('unsafe_path'); await directory(targetDir); };
          try {
            return await withFileLock(checkpoint, async () => {
              const catalogs = [], plans = [];
              for (const id of options.seriesIds) {
                const catalog = catalogFor(await session.catalog(id, active), id);
                const selected = options.episodes === null ? catalog.episodes : catalog.episodes.filter(episode => options.episodes.includes(episode.index));
                if (!selected.length || options.episodes !== null && selected.length !== options.episodes.length) fail('v2_catalog_invalid');
                catalogs.push(catalog); plans.push({ catalog, selected });
              }
              const prior = await jsonFile(targetDir, checkpoint, this.config.maxResponseBytes);
              if (prior && (prior.version !== 2 || prior.backend !== 'v2' || prior.sourceIdentity !== session.sourceIdentity
                || JSON.stringify(prior.request) !== JSON.stringify(request) || !Array.isArray(prior.completed)
                || prior.completed.some(item => !object(item) || typeof item.seriesId !== 'string' || !Number.isSafeInteger(item.index) || !object(item.episode))
                || catalogKey(prior.catalogs) !== catalogKey(catalogs))) fail('v2_checkpoint_invalid');
              const state = { version: 2, backend: 'v2', sourceIdentity: session.sourceIdentity, request, catalogs, completed: [] };
              let reused = 0, downloaded = 0;
              progress = () => ({ path: targetDir, checkpoint, retainedEpisodeCount: state.completed.length, reusedEpisodeCount: reused,
                newlyDownloadedEpisodeCount: downloaded, remainingEpisodeCount: plans.reduce((sum, plan) => sum + plan.selected.length, 0) - state.completed.length,
                discoveryTruncated: false, sourceIdentity: session.sourceIdentity });
              const save = async (committed = false) => {
                await checkRoot(); if (!committed) active.throwIfAborted();
                const text = JSON.stringify(state, null, 2) + '\n';
                if (Buffer.byteLength(text) > this.config.maxResponseBytes) fail('v2_checkpoint_invalid');
                await writeFileAtomic(checkpoint, text, { mode: 0o600 });
              };
              for (const { catalog, selected } of plans) for (const episode of selected) {
                const previous = prior?.completed.find(item => item.seriesId === catalog.seriesId && item.index === episode.index);
                if (previous && previous.episode.path === join(targetDir, catalog.seriesId, filename(episode.index))
                  && previous.episode.origin === 'engine-output' && previous.episode.encryptedSource === null
                  && previous.episode.sourceBytes === null && previous.episode.sourceSha256 === null
                  && Number.isFinite(previous.episode.durationSeconds) && previous.episode.durationSeconds > 0
                  && await verifiedEpisode(targetDir, previous.episode, this.config, active)) {
                  const retained = previous.episode;
                  state.completed.push({ seriesId: catalog.seriesId, index: episode.index, episode: {
                    index: episode.index, title: episode.title, path: retained.path, bytes: retained.bytes, sha256: retained.sha256,
                    durationSeconds: retained.durationSeconds, sourceBytes: null, sourceSha256: null, encryptedSource: null,
                    origin: 'engine-output', format: 'mp4', validationLevel: 'ffprobe-full-decode-sha256', fullDecodeChecked: true,
                  } }); reused++;
                }
              }
              await save();
              for (const { catalog, selected } of plans) {
                const missing = selected.filter(episode => !state.completed.some(item => item.seriesId === catalog.seriesId && item.index === episode.index));
                if (!missing.length) continue;
                active.throwIfAborted();
                const indices = missing.map(episode => episode.index);
                const { job, folder } = await session.download(catalog.seriesId, catalog.title, indices, this.config.v2Quality, active);
                if (!object(job) || job.state !== 'done' || job.done !== missing.length || job.episodes !== missing.length || job.failed !== 0) fail('v2_download_failed');
                if (!inside(paths.outputDir, folder)) fail('unsafe_path');
                await directory(folder);
                const finalFolder = join(targetDir, catalog.seriesId); await checkRoot(); await directory(finalFolder, true);
                for (const episode of missing) {
                  active.throwIfAborted(); await checkRoot();
                  const target = join(finalFolder, filename(episode.index));
                  const facts = await this.publishFile(join(folder, filename(episode.index)), target, paths, active);
                  state.completed.push({ seriesId: catalog.seriesId, index: episode.index,
                    episode: { index: episode.index, title: episode.title, path: target, ...facts } });
                  downloaded++; await save(true); active.throwIfAborted();
                }
              }
              const items = catalogs.map(catalog => {
                const episodes = state.completed.filter(item => item.seriesId === catalog.seriesId).map(item => item.episode).sort((a, b) => a.index - b.index);
                return { seriesId: catalog.seriesId, title: catalog.title, source: 'hongguo-v2', episodeCount: catalog.episodeCount,
                  downloadedEpisodeCount: episodes.length, complete: episodes.length === catalog.episodeCount && episodes.every((episode, index) => episode.index === index + 1),
                  path: join(targetDir, catalog.seriesId), episodes };
              });
              const result = { ok: true, sourceMode: 'legacy', sourceBackend: 'v2', ...progress(), complete: items.every(item => item.complete), items,
                validatedBytes: items.reduce((sum, item) => sum + item.episodes.reduce((bytes, episode) => bytes + episode.bytes, 0), 0),
                validationLevel: 'ffprobe-full-decode-sha256', fullDecodeChecked: true,
                note: '仅标记真实下载并独立验证的 v2 文件；部分选集不是全剧。已验证的本地复用文件不代表当前取流授权仍有效。' };
              await paths.close();
              await checkRoot(); active.throwIfAborted();
              const receipt = JSON.stringify(result, null, 2) + '\n';
              if (Buffer.byteLength(receipt) > this.config.maxResponseBytes) fail('v2_checkpoint_invalid');
              await writeFileAtomic(join(targetDir, 'download-manifest.json'), receipt, { mode: 0o600 });
              return result;
            }, { waitMs: 0 });
          } catch (error) {
            if (typeof error.message === 'string' && error.message.startsWith('atomic-write: timed out')) fail('download_in_progress');
            throw error;
          }
        });
      } catch (error) {
        return { ok: false, complete: false, sourceMode: 'legacy', sourceBackend: 'v2', ...safeFailure(error, active),
          ...(progress ? progress() : {}), resume: { seriesIds: options.seriesIds,
            ...(options.episodes === null ? {} : { episodes: options.episodes }), sourceMode: 'legacy', outputDir: options.outputDir } };
      }
    });
  }

  /**
   * Abort calls, then wait for their sessions and private temporary directories to settle.
   * @returns {Promise<void>} Completion of all owned calls and their cleanup.
   * @throws {Error} A fixed v2_shutdown error when any owned session's exit remains unconfirmed.
   */
  dispose() {
    if (!this.disposeTask) this.disposeTask = (async () => {
      this.lifetime.abort(); await Promise.allSettled([...this.pending]);
      if (this.cleanupError) throw this.cleanupError;
    })();
    return this.disposeTask;
  }
}
