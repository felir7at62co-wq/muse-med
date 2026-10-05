/** Source-preserving multi-series downloader with atomic batch publication and cancellation cleanup. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveConfig } from './config.js';
import { DownloadError, safeError } from './errors.js';
import { checkedUrl, officialRequest } from './network.js';
import { ORIGIN, parsePlayer, seriesId, episodeNumber } from './parser.js';
import { responseBytes, SourceCatalog } from './source.js';
import { ManifestCatalog } from './manifest.js';
import { validateMp4 } from './media.js';
import { createMediaProcessor } from './runtime.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const modes = ['legacy', 'manifest', 'public'];
const within = (root, target) => { const path = relative(root, target); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };
const note = mode => mode === 'legacy' ? '使用所提供源码中的原红果接口；只有声明总集数与全部文件一致时才标记全剧。'
  : mode === 'manifest' ? '修复源码的授权媒体目录；完整仅指目录声明的媒体列表，不代表红果平台全剧验收。'
    : '显式使用红果官网公开播放器；试看集不代表全剧。';

function argumentsFor(args, config, download) {
  if (!record(args)) throw new DownloadError('invalid_arguments', '工具参数必须是对象');
  const allowed = download ? ['seriesIds', 'sourceMode', 'episodes', 'outputDir'] : ['seriesIds', 'sourceMode'];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new DownloadError('invalid_arguments', '工具参数包含未知字段');
  const mode = args.sourceMode ?? config.sourceMode;
  if (!modes.includes(mode)) throw new DownloadError('invalid_arguments', 'sourceMode 必须是 legacy、manifest 或 public');
  if (!Array.isArray(args.seriesIds) || !args.seriesIds.length || args.seriesIds.length > config.maxSeries
    || args.seriesIds.some(id => typeof id !== 'string' || !id || id.length > 120)) throw new DownloadError('invalid_arguments', `seriesIds 必须包含 1–${config.maxSeries} 个字符串 ID`);
  if (new Set(args.seriesIds).size !== args.seriesIds.length) throw new DownloadError('invalid_arguments', 'seriesIds 不能重复');
  if (mode !== 'manifest') {
    try { args.seriesIds.forEach(seriesId); } catch (error) { throw new DownloadError('invalid_arguments', '红果 seriesIds 必须是十进制字符串 ID'); }
  }
  let episodes = null;
  if (args.episodes !== undefined) {
    if (!Array.isArray(args.episodes) || !args.episodes.length || args.episodes.length > config.maxEpisodes
      || new Set(args.episodes).size !== args.episodes.length) throw new DownloadError('invalid_arguments', 'episodes 必须是不重复的正整数集号列表');
    try { args.episodes.forEach(episodeNumber); } catch (error) { throw new DownloadError('invalid_arguments', 'episodes 集号无效'); }
    episodes = [...args.episodes].sort((a, b) => a - b);
  }
  if (args.outputDir !== undefined && (typeof args.outputDir !== 'string' || !args.outputDir.trim() || args.outputDir.includes('\0'))) throw new DownloadError('invalid_arguments', 'outputDir 必须是有效的工作区内目录');
  return { seriesIds: [...args.seriesIds], mode, episodes, outputDir: args.outputDir };
}

async function outputDirectory(workspace, value) {
  if (!workspace || !isAbsolute(workspace)) throw new DownloadError('missing_workspace', '缺少当前会话工作区路径，无法决定下载位置');
  const root = await realpath(workspace);
  const requested = resolve(isAbsolute(value ?? '') ? workspace : root, value ?? 'downloads');
  // Absolute arguments can refer to a symlinked workspace itself, but never to directories outside it.
  const target = within(workspace, requested) ? resolve(root, relative(workspace, requested)) : requested;
  if (!within(root, target)) throw new DownloadError('unsafe_path', 'outputDir 必须位于当前会话工作区内');
  let directory = root;
  for (const component of relative(root, target).split(sep).filter(Boolean)) {
    directory = join(directory, component);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !within(root, await realpath(directory))) throw new DownloadError('unsafe_path', '下载目录包含链接或越出当前工作区');
  }
  return target;
}

function slug(value) {
  const clean = value.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim() || 'series';
  let result = '';
  for (const char of clean) { if (Buffer.byteLength(result + char) > 100) break; result += char; }
  return /^(?:CON|PRN|AUX|NUL|COM\d|LPT\d)(?:\.|$)/i.test(result) ? `_${result}` : result;
}

/** Calls own their pending promises; dispose aborts and waits for all filesystem cleanup. */
export class HongguoDownloadClient {
  constructor(config = {}, dependencies = {}) {
    this.config = resolveConfig(config);
    this.request = dependencies.request ?? officialRequest;
    this.source = dependencies.source ?? new SourceCatalog(this.config, { request: this.request, sign: dependencies.sign });
    this.processMedia = dependencies.processMedia ?? (dependencies.subprocess ? createMediaProcessor(dependencies.subprocess, this.config) : null);
    this.manifest = new ManifestCatalog(this.config);
    this.lifetime = new AbortController();
    this.pending = new Set();
  }

  /** Abort all owned work and resolve only after pending calls and their cleanup settle. */
  async dispose() { this.lifetime.abort(); await Promise.allSettled([...this.pending]); }

  run(signal, operation) {
    const active = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(this.config.callTimeoutMs)]);
    const work = (async () => {
      try { active.throwIfAborted(); return await operation(active); }
      catch (error) {
        if (active.aborted) return { ok: false, complete: false, code: 'cancelled', message: '下载已取消或超过时限；未完成文件已清理' };
        return { ok: false, complete: false, ...safeError(error) };
      }
    })();
    this.pending.add(work);
    void work.then(() => this.pending.delete(work));
    return work;
  }

  async player(id, episode, signal) {
    const active = AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
    const response = await this.request(`${ORIGIN}/player/${id}${episode === 1 ? '' : `/${episode}`}`, 'page', active);
    const html = (await responseBytes(response, this.config.maxResponseBytes, active)).toString('utf8');
    try { return parsePlayer(html, id, episode); }
    catch (error) { throw new DownloadError('invalid_player', '官网没有返回请求集的有效播放器数据'); }
  }

  async catalog(id, mode, signal) {
    const active = AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
    if (mode === 'legacy') return this.source.episodes(id, active);
    if (mode === 'manifest') return this.manifest.episodes(id);
    const { info } = await this.player(id, 1, active);
    if (info.episodeCount > this.config.maxEpisodes) throw new DownloadError('episode_limit', '官网剧集超过配置的 maxEpisodes');
    return { seriesId: id, title: info.title, episodeCount: info.episodeCount, source: 'official-public-player',
      accessibleEpisodeCount: info.accessibleEpisodeCount, episodes: Array.from({ length: info.episodeCount }, (_, position) => ({ index: position + 1, vid: `${id}:${position + 1}`, title: `第 ${position + 1} 集`, durationSeconds: null })) };
  }

  /** List declared counts without returning signed URLs or treating configuration as live verification. */
  info(args, signal) {
    return this.run(signal, async active => {
      const options = argumentsFor(args, this.config, false), items = [];
      for (const id of options.seriesIds) {
        const catalog = await this.catalog(id, options.mode, active);
        items.push({ seriesId: id, title: catalog.title, source: catalog.source, episodeCount: catalog.episodeCount,
          accessibleEpisodeCount: catalog.accessibleEpisodeCount ?? catalog.episodeCount,
          completeCatalog: catalog.episodes.length === catalog.episodeCount, downloaded: false,
          fullSeriesAvailable: options.mode !== 'public' || catalog.accessibleEpisodeCount === catalog.episodeCount });
      }
      return { ok: true, sourceMode: options.mode, items, verifiedDownload: false, note: note(options.mode) };
    });
  }

  async mediaOptions(catalog, batch, mode, signal) {
    if (mode === 'legacy') return this.source.videoUrls(batch.map(episode => episode.vid), AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]));
    if (mode === 'manifest') return new Map(batch.map(episode => [episode.vid, { url: episode.url, expectedBytes: episode.expectedBytes, sha256: episode.sha256 }]));
    const result = new Map();
    for (const episode of batch) {
      const player = await this.player(catalog.seriesId, episode.index, signal);
      if (!player.mediaUrl) throw new DownloadError('public_preview_only', '官网没有开放请求集；试看不算全剧下载');
      episode.durationSeconds = player.info.durationSeconds;
      result.set(episode.vid, { url: player.mediaUrl, expectedBytes: null, sha256: null, headers: { referer: `${ORIGIN}/` } });
    }
    return result;
  }

  async saveEpisode(media, path, signal, workspace, refresh) {
    checkedUrl(media.url, 'media', this.config.mediaHosts, this.config.mediaPorts);
    const part = `${path}.part`;
    const decoded = `${path}.decoded.part`;
    for (let attempt = 0; ; attempt++) {
      const active = AbortSignal.any([signal, AbortSignal.timeout(this.config.downloadTimeoutMs)]);
      let file, response;
      try {
        active.throwIfAborted();
        response = await this.request(media.url, 'media', active, { allowedHosts: this.config.mediaHosts, allowedPorts: this.config.mediaPorts,
          headers: { 'user-agent': this.config.mediaUserAgent, ...media.headers } });
        if (response.statusCode !== 200) throw new DownloadError('http_error', `媒体返回 HTTP ${response.statusCode}`);
        const encoding = response.headers['content-encoding'];
        if (encoding && encoding !== 'identity') throw new DownloadError('encoding', '媒体使用不支持的传输编码');
        if (/text\/|html|json|mpegurl/i.test(response.headers['content-type'] ?? '')) throw new DownloadError('invalid_media', '服务器返回网页、JSON 或 HLS，下载已拒绝');
        const lengthText = response.headers['content-length'];
        const expected = lengthText === undefined ? null : Number(lengthText);
        if (lengthText !== undefined && (!/^\d+$/.test(lengthText) || !Number.isSafeInteger(expected) || expected <= 0 || expected > this.config.maxEpisodeBytes)) throw new DownloadError('media_size', '媒体长度无效或超过配置的 maxEpisodeBytes');
        file = await open(part, 'wx', 0o600);
        const digest = createHash('sha256'); let bytes = 0;
        for await (const chunk of response) {
          active.throwIfAborted(); bytes += chunk.length;
          if (bytes > this.config.maxEpisodeBytes) throw new DownloadError('media_size', '媒体超过配置的 maxEpisodeBytes');
          await file.writeFile(chunk); digest.update(chunk);
        }
        active.throwIfAborted();
        if (!bytes || (expected !== null && bytes !== expected) || (media.expectedBytes !== null && bytes !== media.expectedBytes)) throw new DownloadError('incomplete_media', '媒体实际长度与来源声明不一致');
        const sha256 = digest.digest('hex');
        if (media.sha256 && sha256 !== media.sha256) throw new DownloadError('checksum_mismatch', '媒体 SHA256 与授权目录声明不一致');
        await file.sync(); await file.close(); file = null;
        if (!media.encryption) await validateMp4(part);
        if (!this.processMedia) throw new DownloadError('missing_media_runtime', '缺少受管视频处理运行时；无法验证解密和完整播放');
        const validation = await this.processMedia(media, { inputPath: part, outputPath: decoded, workspace, signal: active });
        const processed = media.encryption ? decoded : part;
        if (validation.processedPath !== processed || validation.fullDecodeChecked !== true) throw new DownloadError('invalid_media', '视频处理未返回完整解码验证结果');
        await validateMp4(processed);
        let finalBytes = bytes, finalSha256 = sha256;
        if (media.encryption) {
          finalBytes = 0;
          const finalDigest = createHash('sha256');
          const stream = createReadStream(processed, { signal: active });
          for await (const chunk of stream) {
            active.throwIfAborted(); finalBytes += chunk.length;
            if (finalBytes > this.config.maxEpisodeBytes) throw new DownloadError('media_size', '解密媒体超过配置的 maxEpisodeBytes');
            finalDigest.update(chunk);
          }
          finalSha256 = finalDigest.digest('hex');
        }
        active.throwIfAborted(); await rename(processed, path);
        return { bytes: finalBytes, sha256: finalSha256, sourceBytes: bytes, sourceSha256: sha256,
          encryptedSource: Boolean(media.encryption), durationSeconds: validation.durationSeconds,
          format: 'mp4', validationLevel: 'ffprobe-full-decode-sha256', fullDecodeChecked: true };
      } catch (error) {
        if (signal.aborted || attempt >= this.config.retries || !['network', 'incomplete_media', 'http_error', ...(refresh ? ['unsafe_redirect'] : [])].includes(error.code)) throw error;
        if (error.code === 'http_error' && response?.statusCode < 500 && response?.statusCode !== 429 && !(refresh && response?.statusCode === 403)) throw error;
      } finally {
        response?.destroy();
        if (file) await file.close();
        await rm(part, { force: true });
        await rm(decoded, { force: true });
      }
      if (this.config.retryDelayMs) await delay(this.config.retryDelayMs, undefined, { signal });
      if (refresh) {
        media = await refresh();
        if (!media) throw new DownloadError('missing_episode_url', '原源未返回可刷新的媒体地址，整批下载尚未完成');
        checkedUrl(media.url, 'media', this.config.mediaHosts, this.config.mediaPorts);
      }
    }
  }

  /** Publish one batch only after every requested episode passes; a failure removes all owned partial files. */
  download(args, signal, workspace) {
    return this.run(signal, async active => {
      const options = argumentsFor(args, this.config, true), plans = [];
      for (const id of options.seriesIds) {
        const catalog = await this.catalog(id, options.mode, active);
        const selected = options.episodes ? catalog.episodes.filter(episode => options.episodes.includes(episode.index)) : catalog.episodes;
        if (options.episodes && selected.length !== options.episodes.length) throw new DownloadError('episode_not_found', '请求集号不在此剧完整列表中');
        if (options.mode === 'public' && selected.some(episode => episode.index > catalog.accessibleEpisodeCount)) throw new DownloadError('public_preview_only', `官网仅开放 ${catalog.accessibleEpisodeCount}/${catalog.episodeCount} 集；没有将试看替代全剧`);
        plans.push({ catalog, selected });
      }
      const directory = await outputDirectory(workspace ?? this.config.outputRoot, options.outputDir);
      active.throwIfAborted();
      const staging = await mkdtemp(join(directory, '.hongguo-partial-'));
      const final = join(directory, `hongguo-${randomUUID()}`), items = [];
      let published = false, renamed = false;
      const workers = new AbortController();
      const workerSignal = AbortSignal.any([active, workers.signal]);
      try {
        for (const { catalog, selected } of plans) {
          const folderName = `${slug(catalog.title)}-${slug(catalog.seriesId)}`;
          const folder = join(staging, folderName); await mkdir(folder, { mode: 0o700 });
          const episodes = [];
          for (let offset = 0; offset < selected.length; offset += 5) {
            workerSignal.throwIfAborted();
            const batch = selected.slice(offset, offset + 5);
            const urls = await this.mediaOptions(catalog, batch, options.mode, workerSignal);
            let next = 0;
            const jobs = Array.from({ length: Math.min(this.config.concurrency, batch.length) }, async () => {
              while (next < batch.length) {
                workerSignal.throwIfAborted(); const episode = batch[next++];
                const media = urls.get(episode.vid);
                if (!media) throw new DownloadError('missing_episode_url', '来源没有返回某集媒体地址，整批下载尚未完成');
                const filename = `${String(episode.index).padStart(4, '0')}.mp4`;
                const refresh = options.mode === 'legacy' ? async () => (await this.mediaOptions(catalog, [episode], options.mode, workerSignal)).get(episode.vid) : null;
                const saved = await this.saveEpisode(media, join(folder, filename), workerSignal, staging, refresh);
                episodes.push({ index: episode.index, title: episode.title, path: join(final, folderName, filename), durationSeconds: episode.durationSeconds, ...saved });
              }
            });
            let firstFailure;
            const owned = jobs.map(job => job.catch(error => { firstFailure ??= error; workers.abort(); throw error; }));
            const settled = await Promise.allSettled(owned);
            if (settled.some(result => result.status === 'rejected')) throw firstFailure;
          }
          episodes.sort((a, b) => a.index - b.index);
          const complete = episodes.length === catalog.episodeCount && episodes.every((episode, index) => episode.index === index + 1);
          items.push({ seriesId: catalog.seriesId, title: catalog.title, source: catalog.source, episodeCount: catalog.episodeCount,
            downloadedEpisodeCount: episodes.length, complete, path: join(final, folderName), episodes });
        }
        active.throwIfAborted();
        const value = { ok: true, sourceMode: options.mode, complete: items.every(item => item.complete), path: final, items,
          validatedBytes: items.reduce((sum, item) => sum + item.episodes.reduce((total, episode) => total + episode.bytes, 0), 0),
          validationLevel: 'ffprobe-full-decode-sha256', fullDecodeChecked: true, note: note(options.mode) };
        await writeFile(join(staging, 'download-manifest.json'), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        active.throwIfAborted();
        if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new DownloadError('unsafe_path', '下载输出目录已被替换为链接');
        await rename(staging, final); renamed = true;
        active.throwIfAborted(); published = true;
        return value;
      } finally { if (!published) await rm(renamed ? final : staging, { recursive: true, force: true }); }
    });
  }
}

export { resolveConfig } from './config.js';
