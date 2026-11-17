/** Multi-series downloader with validated per-episode progress, durable recovery and owned cancellation. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, realpath, link, rm, mkdtemp } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveConfig } from './config.js';
import { DownloadError, safeError } from './errors.js';
import { checkedUrl, officialRequest } from './network.js';
import { ORIGIN, parsePlayer, parsePublicPlayback, seriesId, episodeNumber } from './parser.js';
import { responseBytes } from './source.js';
import { JackotomSource } from './jackotom.js';
import { ManifestCatalog } from './manifest.js';
import { validateMp4 } from './media.js';
import { createMediaProcessor } from './runtime.js';
import { transferMedia } from './transfer.js';
import { DownloadCheckpoint, discoverReceipts, reusableSeries, verifiedEpisode } from './checkpoint.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const modes = ['legacy', 'manifest', 'public'];
const within = (root, target) => { const path = relative(root, target); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };
const note = mode => mode === 'legacy' ? '使用 jackotom/hongguo-drama 开源引擎；只有声明总集数与全部文件一致时才标记全剧。'
  : mode === 'manifest' ? '修复源码的授权媒体目录；完整仅指目录声明的媒体列表，不代表红果平台全剧验收。'
    : '显式使用红果官网公开播放器；试看集不代表全剧。';

function argumentsFor(args, config, download) {
  if (!record(args)) throw new DownloadError('invalid_arguments', '工具参数必须是对象');
  const allowed = download ? ['seriesIds', 'sourceMode', 'episodes', 'outputDir', 'quality'] : ['seriesIds', 'sourceMode'];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new DownloadError('invalid_arguments', '工具参数包含未知字段');
  const mode = args.sourceMode ?? config.sourceMode;
  if (!modes.includes(mode)) throw new DownloadError('invalid_arguments', 'sourceMode 必须是 legacy、manifest 或 public');
  // Public and manifest requests historically preserve source bytes; only the open engine has a selectable deployment default.
  const quality = args.quality === undefined ? (mode === 'legacy' ? config.quality : 'auto') : args.quality;
  if (!['1080p', '720p', 'auto'].includes(quality)) throw new DownloadError('invalid_arguments', 'quality 必须是 1080p、720p 或 auto');
  if (!Array.isArray(args.seriesIds) || !args.seriesIds.length || args.seriesIds.length > config.maxSeries
    || args.seriesIds.some(id => typeof id !== 'string' || !id || id.length > 120)) throw new DownloadError('invalid_arguments', `seriesIds 必须包含 1–${config.maxSeries} 个字符串 ID`);
  if (new Set(args.seriesIds).size !== args.seriesIds.length) throw new DownloadError('invalid_arguments', 'seriesIds 不能重复');
  if (mode !== 'manifest') {
    try { args.seriesIds.forEach(seriesId); } catch (error) { throw new DownloadError('invalid_arguments', '红果 seriesIds 必须是十进制字符串 ID'); }
  }
  let episodes = null;
  if (args.episodes !== undefined) {
    if (!Array.isArray(args.episodes) || !args.episodes.length
      || new Set(args.episodes).size !== args.episodes.length) throw new DownloadError('invalid_arguments', 'episodes 必须是不重复的正整数集号列表');
    try { args.episodes.forEach(episodeNumber); } catch (error) { throw new DownloadError('invalid_arguments', 'episodes 集号无效'); }
    episodes = [...args.episodes].sort((a, b) => a - b);
  }
  if (args.outputDir !== undefined && (typeof args.outputDir !== 'string' || !args.outputDir.trim() || args.outputDir.includes('\0'))) throw new DownloadError('invalid_arguments', 'outputDir 必须是有效的目录路径');
  return Object.freeze({ seriesIds: [...args.seriesIds], mode, episodes, outputDir: args.outputDir, quality });
}

async function outputDirectory(workspace, value, filePolicy) {
  if (!workspace || !isAbsolute(workspace)) throw new DownloadError('missing_workspace', '缺少当前会话工作区路径，无法决定下载位置');
  if (filePolicy?.mode === 'read-only') throw new DownloadError('file_access_denied', '当前会话为只读权限，无法下载文件；请在界面调整文件访问权限');
  const root = await realpath(workspace);
  const requested = resolve(isAbsolute(value ?? '') ? workspace : root, value ?? 'downloads');
  let target = within(workspace, requested) ? resolve(root, relative(workspace, requested)) : requested;
  if (!isAbsolute(value ?? '') && !within(root, target)) throw new DownloadError('unsafe_path', '相对 outputDir 不能越出工作区；请使用目标目录的绝对路径');
  let anchor = root;
  if (!within(root, target)) {
    // Resolve existing parent aliases before authorizing or creating external directories.
    anchor = target;
    for (;;) {
      try {
        const info = await lstat(anchor);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new DownloadError('unsafe_path', '下载目录包含链接或不是文件夹');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        anchor = dirname(anchor);
      }
    }
    const canonical = await realpath(anchor);
    target = resolve(canonical, relative(anchor, target));
    anchor = canonical;
    if (!within(root, target) && filePolicy?.mode !== 'danger-full-access') throw new DownloadError('file_access_denied', '当前会话仅允许写入工作区；请在界面开启完全权限后直接下载到指定目录');
  }
  const anchorIdentity = await lstat(anchor);
  const check = async create => {
    const current = await lstat(anchor);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== anchorIdentity.dev || current.ino !== anchorIdentity.ino
      || await realpath(anchor) !== anchor) throw new DownloadError('unsafe_path', '下载输出目录已被替换');
    let directory = anchor;
    for (const component of relative(anchor, target).split(sep).filter(Boolean)) {
      directory = join(directory, component);
      if (create) {
        try { await mkdir(directory, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      let info;
      try { info = await lstat(directory); }
      catch (error) { if (!create && error.code === 'ENOENT') return; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new DownloadError('unsafe_path', '下载目录包含链接或已被替换');
    }
  };
  await check(false);
  return { path: target, create: () => check(true) };
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
    this.source = dependencies.source ?? dependencies.sourceFactory?.(this.config) ?? new JackotomSource(this.config, dependencies.engine);
    this.sourceFactory = dependencies.sourceFactory ?? (config => this.source.withQuality?.(config.quality) ?? this.source);
    this.processMedia = dependencies.processMedia ?? (dependencies.subprocess ? createMediaProcessor(dependencies.subprocess, this.config) : null);
    this.manifest = new ManifestCatalog(this.config);
    this.lifetime = new AbortController();
    this.pending = new Set();
  }

  /** Abort all owned work and resolve only after pending calls and their cleanup settle. */
  async dispose() {
    this.lifetime.abort();
    await Promise.allSettled([...this.pending]);
  }

  run(signal, operation) {
    const active = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(this.config.callTimeoutMs)]);
    const work = (async () => {
      try { active.throwIfAborted(); return await operation(active); }
      catch (error) {
        if (active.aborted && error.code !== 'cleanup_unconfirmed') return { ok: false, complete: false, code: 'cancelled', message: '下载已取消或超过时限；未完成文件已清理' };
        return { ok: false, complete: false, ...safeError(error) };
      }
    })();
    this.pending.add(work);
    void work.then(() => this.pending.delete(work));
    return work;
  }

  async player(id, episode, signal, options) {
    const active = AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
    const suffix = episode === 1 ? '' : `/${encodeURIComponent(options?.itemId ?? episode)}`;
    const response = await this.request(`${ORIGIN}/player/${id}${suffix}`, 'page', active);
    const html = (await responseBytes(response, this.config.maxResponseBytes, active)).toString('utf8');
    try { return parsePlayer(html, id, episode, options); }
    catch (error) { throw new DownloadError('invalid_player', '官网没有返回请求集的有效播放器数据'); }
  }

  async catalog(id, mode, signal, source = this.source) {
    const active = AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
    if (mode === 'legacy') return source.episodes(id, active);
    if (mode === 'manifest') return this.manifest.episodes(id);
    const { info, vids } = await this.player(id, 1, active, { metadataOnly: true });
    return { seriesId: id, title: info.title, episodeCount: info.episodeCount, source: 'official-public-player',
      accessibleEpisodeCount: info.accessibleEpisodeCount, episodes: vids.map((vid, position) => ({ index: position + 1, vid, title: `第 ${position + 1} 集`, durationSeconds: null })) };
  }

  /** List declared counts without returning signed URLs or treating configuration as live verification. */
  info(args, signal) {
    return this.run(signal, async active => {
      const options = argumentsFor(args, this.config, false), items = [];
      for (const id of options.seriesIds) {
        const catalog = await this.catalog(id, options.mode, active);
        items.push({ seriesId: id, title: catalog.title, source: catalog.source, episodeCount: catalog.episodeCount,
          accessibleEpisodeCount: catalog.accessibleEpisodeCount ?? null,
          completeCatalog: catalog.episodes.length === catalog.episodeCount, downloaded: false,
          mediaUrlsVerified: false,
          fullSeriesAvailable: options.mode === 'public' && catalog.accessibleEpisodeCount < catalog.episodeCount ? false : null });
      }
      return { ok: true, sourceMode: options.mode, items, verifiedDownload: false,
        note: `${note(options.mode)} 目录完整不代表媒体可下载；媒体地址尚未验证，只有实际下载与完整解码成功后才能确认交付。` };
    });
  }

  async mediaOptions(catalog, batch, mode, signal, source = this.source, quality = this.config.quality, deferred) {
    if (mode === 'legacy') return source.videoUrls(batch.map(episode => episode.vid), signal, catalog.seriesId, { quality, ...(deferred ? { deferred } : {}) });
    if (mode === 'manifest') return new Map(batch.map(episode => [episode.vid, { url: episode.url, expectedBytes: episode.expectedBytes, sha256: episode.sha256 }]));
    const result = new Map();
    for (const episode of batch) {
      const player = await this.player(catalog.seriesId, episode.index, signal, { itemId: episode.vid });
      if (player.info.episodeCount !== catalog.episodeCount || player.vids[episode.index - 1] !== episode.vid) {
        throw new DownloadError('invalid_player', '官网目录或播放集在下载前已变化，请重新读取目录；没有下载其他集');
      }
      if (!player.info.publicPlaybackAvailable) throw new DownloadError('public_preview_only', '官网没有开放请求集；试看不算全剧下载');
      const url = player.publicFallback ? await this.publicPlayback(player.publicFallback.itemId, signal) : player.mediaUrl;
      if (!url) throw new DownloadError('public_preview_only', '官网没有开放请求集；试看不算全剧下载');
      checkedUrl(url, 'media', this.config.mediaHosts, this.config.mediaPorts);
      episode.durationSeconds = player.info.durationSeconds;
      result.set(episode.vid, { url, expectedBytes: null, sha256: null, headers: { referer: `${ORIGIN}/` } });
    }
    return result;
  }

  /** Resolve only a directory-matched open episode through the ordinary anonymous compatibility endpoint. */
  async publicPlayback(itemId, signal) {
    const active = AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
    const body = Buffer.from(JSON.stringify({ item_id: itemId }));
    const response = await this.request(`${ORIGIN}/api/video/protected/fallback-play-info?aid=8662`, 'page', active,
      { method: 'POST', body, headers: { 'content-type': 'application/json', 'content-length': body.length,
        accept: 'application/json', 'x-xs-from-web': '1' } });
    const httpStatus = response.statusCode;
    const bytes = await responseBytes(response, this.config.maxResponseBytes, active);
    const details = { sourceStage: 'video_model', retryable: false, httpStatus, responseBytes: bytes.length };
    if (bytes.length === 0) throw new DownloadError('empty_source_response', '官网兼容播放返回空正文；未确认媒体可用，请勿立即重复请求', details);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch (error) { if (active.aborted) throw error; throw new DownloadError('platform_json', '官网兼容播放返回无效 JSON；没有取得媒体地址', details); }
    return parsePublicPlayback(value, itemId);
  }

  async saveEpisode(media, path, signal, workspace, refresh) {
    checkedUrl(media.url, 'media', this.config.mediaHosts, this.config.mediaPorts);
    for (let attempt = 0; ; attempt++) {
      const active = AbortSignal.any([signal, AbortSignal.timeout(this.config.downloadTimeoutMs)]);
      const stage = await mkdtemp(join(dirname(path), '.media-stage-'));
      const part = join(stage, 'input.part'), decoded = join(stage, 'output.part');
      let cleanupProcessed, preserveStage = false;
      try {
        active.throwIfAborted();
        const { bytes, sha256 } = await transferMedia({ request: this.request, url: media.url, signal: active,
          headers: { 'user-agent': this.config.mediaUserAgent, ...media.headers },
          allowedHosts: this.config.mediaHosts, allowedPorts: this.config.mediaPorts,
          maxBytes: this.config.maxEpisodeBytes, expectedBytes: media.expectedBytes, path: part,
          connections: Math.min(this.config.mediaConnections, Math.floor(this.config.mediaConnectionLimit / this.config.concurrency)),
          minSegmentBytes: this.config.mediaSegmentMinBytes, idleTimeoutMs: this.config.mediaIdleTimeoutMs });
        if (media.sha256 && sha256 !== media.sha256) throw new DownloadError('checksum_mismatch', '媒体 SHA256 与授权目录声明不一致');
        if (!media.encryption) await validateMp4(part);
        if (!this.processMedia) throw new DownloadError('missing_media_runtime', '缺少受管视频处理运行时；无法验证解密和完整播放');
        const validation = await this.processMedia(media, { inputPath: part, outputPath: decoded, workspace, signal: active });
        cleanupProcessed = validation.cleanup;
        const width = Number.isSafeInteger(validation.width) && validation.width > 0 ? validation.width : null;
        const height = Number.isSafeInteger(validation.height) && validation.height > 0 ? validation.height : null;
        if (media.requireQualityMetadata && media.quality !== 'auto' && (width === null || height === null)) {
          throw new DownloadError('quality_unverified', '未取得视频实测尺寸，无法确认请求清晰度；没有生成成功回执');
        }
        if (media.quality !== undefined && media.quality !== 'auto' && width !== null && height !== null
          && Math.min(width, height) < (media.quality === '1080p' ? 1080 : 720)) {
          throw new DownloadError('quality_unavailable', '视频实际尺寸低于请求清晰度；没有降级或生成成功回执');
        }
        const processed = media.encryption || media.codec === 'bytevc2' ? decoded : part;
        if (validation.processedPath !== processed || validation.fullDecodeChecked !== true) throw new DownloadError('invalid_media', '视频处理未返回完整解码验证结果');
        await validateMp4(processed);
        let finalBytes = bytes, finalSha256 = sha256;
        if (media.encryption || media.codec === 'bytevc2') {
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
        active.throwIfAborted();
        try { await link(processed, path); }
        catch (error) { if (error.code === 'EEXIST') throw new DownloadError('output_exists', '视频目标已存在；已有文件已保留，请检查输出目录'); throw error; }
        return { bytes: finalBytes, sha256: finalSha256, sourceBytes: bytes, sourceSha256: sha256,
          encryptedSource: Boolean(media.encryption), ...(media.codec === 'bytevc2' ? { convertedFrom: 'bytevc2' } : {}), durationSeconds: validation.durationSeconds,
          width, height, quality: width !== null && height !== null ? `${Math.min(width, height)}p` : null,
          videoCodec: typeof validation.videoCodec === 'string' ? validation.videoCodec : null,
          format: 'mp4', validationLevel: 'ffprobe-full-decode-sha256', fullDecodeChecked: true };
      } catch (error) {
        preserveStage = error.code === 'cleanup_unconfirmed';
        if (signal.aborted || attempt >= this.config.retries || !['network', 'incomplete_media', 'http_error', ...(refresh ? ['unsafe_redirect'] : [])].includes(error.code)) throw error;
        if (error.code === 'http_error' && error.httpStatus < 500 && error.httpStatus !== 429 && !(refresh && error.httpStatus === 403)) throw error;
      } finally {
        if (!preserveStage) { await cleanupProcessed?.(); await rm(stage, { recursive: true, force: true }); }
      }
      if (this.config.retryDelayMs) await delay(this.config.retryDelayMs, undefined, { signal });
      if (refresh) {
        media = await refresh();
        if (!media) throw new DownloadError('missing_episode_url', '原源未返回可刷新的媒体地址，整批下载尚未完成');
        checkedUrl(media.url, 'media', this.config.mediaHosts, this.config.mediaPorts);
      }
    }
  }

  /** Resolve safe, immutable task arguments without network requests or creating output directories. */
  async resolveTaskRequest(args, workspace, filePolicy) {
    const { options, output, sourceIdentity } = await this.requestSpec(args, workspace, filePolicy);
    return { request: { seriesIds: options.seriesIds, sourceMode: options.mode, quality: options.quality,
      ...(options.episodes ? { episodes: options.episodes } : {}), outputDir: output.path }, sourceIdentity,
      checkpointDirectory: new DownloadCheckpoint(output.path, { ...options, sourceIdentity }, this.config).directory };
  }

  /** Reauthorize the frozen output without loading catalogs or contacting its source. */
  async resolveTaskOutput(request, workspace, filePolicy) {
    const options = argumentsFor(request, this.config, true);
    const output = await outputDirectory(workspace, options.outputDir, filePolicy);
    if (output.path !== request.outputDir) throw new DownloadError('task_source_changed', '下载任务输出目录已变化');
    return output;
  }

  async requestSpec(args, workspace, filePolicy) {
    const options = argumentsFor(args, this.config, true);
    const output = await outputDirectory(workspace ?? this.config.outputRoot, options.outputDir, filePolicy);
    const requestConfig = Object.freeze({ ...this.config, quality: options.quality });
    const source = options.mode === 'legacy' ? this.sourceFactory(requestConfig) : this.source;
    const manifestCatalogs = options.mode === 'manifest' ? await this.manifest.load() : null;
    const baseIdentity = manifestCatalogs ? createHash('sha256').update(JSON.stringify(manifestCatalogs)).digest('hex') : source.identity ?? null;
    // The pinned engine already records quality; preserve those checkpoint ids and source-preserving auto requests.
    const sourceIdentity = options.mode === 'legacy'
      ? typeof baseIdentity === 'string' && baseIdentity.startsWith('jackotom:') && baseIdentity.endsWith(`:${options.quality}`)
        ? baseIdentity : `${baseIdentity ?? 'legacy'}:quality:${options.quality}`
      : options.quality === 'auto' ? baseIdentity : `${baseIdentity ?? 'public'}:quality:${options.quality}`;
    return { options, output, source, manifestCatalogs, sourceIdentity };
  }

  /** Retain verified episodes across interrupted calls; only a complete request publishes a success receipt. */
  download(args, signal, workspace, filePolicy, observer = {}) {
    return this.run(signal, async active => {
      const { options, output, source, manifestCatalogs, sourceIdentity } = await this.requestSpec(args, workspace, filePolicy), plans = [];
      const checkpoint = new DownloadCheckpoint(output.path, { ...options, sourceIdentity }, this.config);
      const prior = await checkpoint.read();
      const discovery = await discoverReceipts(output.path, options.mode, this.config, active, sourceIdentity, options.quality);
      const retained = new Map();
      for (const id of options.seriesIds) {
        const existing = await reusableSeries(output.path, discovery.items, id, options.episodes, this.config, active, options.quality);
        if (existing) retained.set(id, existing);
        const saved = prior?.plans.find(plan => plan.seriesId === id && !plan.fromReceipt);
        const catalog = existing ? { seriesId: id, title: existing.title, source: existing.source,
          episodeCount: existing.episodeCount, fromReceipt: true,
          episodes: discovery.items.find(item => item.seriesId === id && item.episodeCount === existing.episodeCount).episodes
            .map(episode => ({ index: episode.index, vid: `retained:${episode.index}`, title: episode.title, durationSeconds: episode.durationSeconds })) }
          : manifestCatalogs ? manifestCatalogs.find(item => item.seriesId === id) : saved ?? await this.catalog(id, options.mode, active, source);
        if (!catalog) throw new DownloadError('series_not_found', '授权媒体目录中没有请求的系列');
        const selected = options.episodes ? catalog.episodes.filter(episode => options.episodes.includes(episode.index)) : catalog.episodes;
        if (options.episodes && selected.length !== options.episodes.length) throw new DownloadError('episode_not_found', '请求集号不在此剧完整列表中');
        if (options.mode === 'public' && !existing && selected.some(episode => episode.index > catalog.accessibleEpisodeCount)) throw new DownloadError('public_preview_only', `官网仅开放 ${catalog.accessibleEpisodeCount}/${catalog.episodeCount} 集；没有将试看替代全剧`);
        plans.push({ catalog, selected });
      }
      await output.create(); active.throwIfAborted();
      return await checkpoint.locked(async () => {
        const previous = await checkpoint.read();
        const state = { version: 1, request: checkpoint.request, plans: plans.map(({ catalog }) => ({ ...catalog, episodes: catalog.episodes.map(({ index, vid, title, durationSeconds }) => ({ index, vid, title, durationSeconds })) })), completed: [] };
        let saveTail = Promise.resolve();
        const persist = () => {
          const snapshot = { ...state, completed: [...state.completed] };
          const pending = saveTail.then(() => checkpoint.save(snapshot));
          saveTail = pending.catch(() => {});
          return pending;
        };
        let reused = 0, downloaded = 0;
        for (const { catalog, selected } of plans) {
          for (const episode of selected) {
            const old = retained.get(catalog.seriesId)?.episodes.find(item => item.index === episode.index)
              ?? previous?.completed.find(item => item.seriesId === catalog.seriesId && item.vid === episode.vid)?.episode;
            if (old?.index === episode.index && await verifiedEpisode(output.path, old, this.config, active, options.quality)) {
              state.completed.push({ seriesId: catalog.seriesId, vid: episode.vid, episode: { ...old,
                width: old.width ?? null, height: old.height ?? null, quality: old.quality ?? null, videoCodec: old.videoCodec ?? null } }); reused++;
            }
          }
        }
        await checkpoint.clearParts(); await persist();
        const workers = new AbortController(), workerSignal = AbortSignal.any([active, workers.signal]);
        let pendingSource, firstFailure;
        const fail = error => { if (!firstFailure || error.code === 'cleanup_unconfirmed') firstFailure = error; workers.abort(); };
        const progress = () => ({ path: checkpoint.directory, checkpoint: checkpoint.file, requestedQuality: options.quality,
          retainedEpisodeCount: state.completed.length, reusedEpisodeCount: reused,
          remainingEpisodeCount: plans.reduce((sum, plan) => sum + plan.selected.length, 0) - state.completed.length,
          discoveryTruncated: discovery.truncated });
        try {
          await observer.onProgress?.(progress());
          for (const { catalog, selected } of plans) {
            const folderName = `${slug(catalog.title)}-${slug(catalog.seriesId)}`;
            const missing = selected.filter(episode => !state.completed.some(item => item.seriesId === catalog.seriesId && item.vid === episode.vid));
            if (!missing.length) continue;
            const folder = await checkpoint.folder(folderName), batchSize = this.config.mediaBatchSize;
            // Open-engine episodes with transient lookup failures move to one retry pass after the rest of the series.
            const deferred = options.mode === 'legacy' ? new Map() : null, later = [];
            let deferredAt = 0;
            const prepare = offset => this.mediaOptions(catalog, missing.slice(offset, offset + batchSize), options.mode, workerSignal, source, options.quality, deferred)
              .then(urls => ({ urls }), error => ({ error }));
            const saveOne = async (episode, selectedMedia) => {
              const media = { ...selectedMedia, quality: options.quality, requireQualityMetadata: options.mode !== 'legacy' };
              const path = join(folder, `${String(episode.index).padStart(4, '0')}.mp4`);
              const refresh = options.mode === 'legacy' ? async () => {
                const refreshed = (await this.mediaOptions(catalog, [episode], options.mode, workerSignal, source, options.quality)).get(episode.vid);
                return refreshed ? { ...refreshed, quality: options.quality, requireQualityMetadata: options.mode !== 'legacy' } : null;
              } : null;
              const saved = await this.saveEpisode(media, path, workerSignal, checkpoint.directory, refresh);
              state.completed.push({ seriesId: catalog.seriesId, vid: episode.vid,
                episode: { index: episode.index, title: episode.title, path, ...saved } }); downloaded++;
              await persist();
              await observer.onProgress?.(progress());
            };
            pendingSource = prepare(0);
            for (let offset = 0; offset < missing.length; offset += batchSize) {
              const prepared = await pendingSource;
              if (prepared.error) throw prepared.error;
              workerSignal.throwIfAborted();
              const batch = missing.slice(offset, offset + batchSize), urls = prepared.urls;
              pendingSource = offset + batchSize < missing.length ? prepare(offset + batchSize) : null;
              let next = 0;
              const jobs = Array.from({ length: Math.min(this.config.concurrency, batch.length) }, async () => {
                while (next < batch.length) {
                  workerSignal.throwIfAborted(); const episode = batch[next++], selectedMedia = urls.get(episode.vid);
                  if (!selectedMedia && deferred?.has(episode.vid)) { later.push(episode); deferredAt = Date.now(); continue; }
                  if (!selectedMedia) throw new DownloadError('missing_episode_url', '来源没有返回某集媒体地址；已完成集保留供续下载');
                  await saveOne(episode, selectedMedia);
                }
              });
              const settled = await Promise.allSettled(jobs.map(job => job.catch(error => { fail(error); throw error; })));
              if (settled.some(result => result.status === 'rejected')) throw firstFailure;
            }
            if (!later.length) continue;
            await delay(Math.max(0, deferredAt + this.config.deferredSourceCooldownMs - Date.now()), undefined, { signal: workerSignal });
            const unresolved = [];
            for (const episode of later.sort((a, b) => a.index - b.index)) {
              let selectedMedia;
              try { selectedMedia = (await this.mediaOptions(catalog, [episode], options.mode, workerSignal, source, options.quality)).get(episode.vid); }
              catch (error) {
                if (!(error instanceof DownloadError) || error.code !== 'source_unavailable') throw error;
                unresolved.push({ episode, error }); continue;
              }
              if (!selectedMedia) throw new DownloadError('missing_episode_url', '来源没有返回某集媒体地址；已完成集保留供续下载');
              await saveOne(episode, selectedMedia);
            }
            if (unresolved.length) {
              const { error } = unresolved[0];
              throw new DownloadError('source_unavailable', `${error.message}；第 ${unresolved.map(item => item.episode.index).join('、')} 集延后重试仍未取到片源，其余集已下载`, {
                sourceStage: error.sourceStage, retryable: unresolved.every(item => item.error.retryable === true),
                upstreamCode: error.upstreamCode, sourceFailures: error.sourceFailures });
            }
          }
          active.throwIfAborted();
          const items = plans.map(({ catalog }) => {
            const episodes = state.completed.filter(item => item.seriesId === catalog.seriesId).map(item => item.episode).sort((a, b) => a.index - b.index);
            const complete = episodes.length === catalog.episodeCount && episodes.every((episode, index) => episode.index === index + 1);
            return { seriesId: catalog.seriesId, title: catalog.title, source: catalog.source, episodeCount: catalog.episodeCount,
              downloadedEpisodeCount: episodes.length, complete, path: retained.get(catalog.seriesId)?.path ?? join(checkpoint.directory, `${slug(catalog.title)}-${slug(catalog.seriesId)}`), episodes };
          });
          const value = { ok: true, sourceMode: options.mode, sourceIdentity, complete: items.every(item => item.complete), items,
            ...progress(), newlyDownloadedEpisodeCount: downloaded,
            validatedBytes: items.reduce((sum, item) => sum + item.episodes.reduce((total, episode) => total + episode.bytes, 0), 0),
            validationLevel: 'ffprobe-full-decode-sha256', fullDecodeChecked: true, note: note(options.mode) };
          await checkpoint.publish(value); return value;
        } catch (error) {
          fail(error); await pendingSource; await saveTail;
          return { ok: false, complete: false, ...safeError(firstFailure), ...progress(),
            resume: { seriesIds: options.seriesIds, ...(options.episodes ? { episodes: options.episodes } : {}), sourceMode: options.mode, outputDir: output.path, quality: options.quality },
            ...(active.aborted && firstFailure.code !== 'cleanup_unconfirmed' ? { code: 'cancelled', message: '下载已取消或超过时限；已验证集和进度已保留，可按原请求继续' } : {}) };
        } finally { workers.abort(); await pendingSource; await saveTail; await checkpoint.clearParts(); }
      });
    });
  }
}

export { resolveConfig } from './config.js';
