/** Pinned upstream catalog and playback adapter; private playback data stays inside the plugin. */
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { DownloadError } from './errors.js';
const require = createRequire(import.meta.url);
const revision = '8d14d07b3aaf99ecbe6b3ecb8ba2d0308261845d';
const sourceNames = { web: '网页', app: 'App', api: '旧接口' };

/** Keep only enumerated upstream failure codes; upstream messages can carry request details. */
function sourceFailures(info) {
  const list = Array.isArray(info?.sources) ? info.sources : [];
  return list.filter(item => Object.hasOwn(sourceNames, item?.source) && /^[A-Z][A-Z0-9_]{0,39}$/.test(String(item?.code ?? '')))
    .slice(0, 6).map(item => ({ source: item.source, code: String(item.code) }));
}

/**
 * Apply the upstream client's rule: timeouts, network failures and 5xx are transient; an App or device refusal is final.
 * Empty play-info responses can recover even when the webpage has a preview.
 */
function transientFailure(info, failures) {
  if (info?.locked) return false;
  if (failures.some(item => item.source === 'app' && /^(?:DEVICE_REGISTRATION_FAILED|HTTP_(?:403|429)|BUSINESS_REJECTED|SECURITY_BLOCKED)$/.test(item.code))) return false;
  const emptyOrMissing = item => item.code === 'EMPTY_RESPONSE' || item.source === 'web' && /^HTTP_(?:404|410)$/.test(item.code);
  const onlyEmptyOrPreview = failures.some(emptyOrMissing)
    && failures.every(item => emptyOrMissing(item) || item.source === 'web' && item.code === 'PREVIEW_ONLY');
  return info?.code === 'ETIMEDOUT' || onlyEmptyOrPreview
    || failures.some(item => emptyOrMissing(item) && item.source === 'web' || /^(?:TIMEOUT|NETWORK_ERROR|HTTP_(?:408|5\d\d))$/.test(item.code));
}

function unavailable(info, failures, transient) {
  const reason = failures.length ? `（${failures.map(item => `${sourceNames[item.source]}：${item.code}`).join('；')}）` : '';
  return new DownloadError('source_unavailable', `红果未返回可用的完整分集片源${reason}；${transient ? '多次重试仍失败，可稍后用同一请求续下载' : '已停止请求'}，已验证文件保留`, {
    sourceStage: 'video_model', retryable: transient,
    ...(/^[A-Z][A-Z0-9_]{0,39}$/.test(String(info?.code ?? '')) ? { upstreamCode: String(info.code) } : {}),
    ...(failures.length ? { sourceFailures: failures } : {}) });
}


/** Adapt the upstream catalog to Muse's validated download and recovery pipeline. */
export class JackotomSource {
  constructor(config, engine) {
    this.config = config;
    this.engine = engine;
    this.identity = `jackotom:${revision}:${config.quality}`;
  }
  load() { return this.engine ??= require('../upstream/engine.cjs'); }
  /** Return an independent request source without changing the engine or another request's quality. */
  withQuality(quality) { return new JackotomSource(Object.freeze({ ...this.config, quality }), this.engine); }
  async episodes(id, signal) {
    signal.throwIfAborted();
    const data = await this.load().fetchEpisodeList(id, { signal, deadline: Date.now() + this.config.requestTimeoutMs });
    signal.throwIfAborted();
    const rows = data.episodes;
    if (String(data.series_id) !== id || !Array.isArray(rows) || !rows.length || rows.length !== Number(data.total)
      || new Set(rows.map(row => row.vid)).size !== rows.length
      || rows.some((row, index) => !/^\d+$/.test(String(row.vid)) || Number(row.vid_index) !== index + 1 || row.locked)) {
      throw new DownloadError('invalid_catalog', '红果目录不完整、集号异常或包含未开放分集', { sourceStage: 'catalog', retryable: false });
    }
    return { seriesId: id, title: String(data.series_title || id), source: 'jackotom/hongguo-drama', episodeCount: rows.length,
      episodes: rows.map((row, index) => ({ index: index + 1, vid: String(row.vid), title: String(row.title || `第${index + 1}集`), durationSeconds: null })) };
  }
  /**
   * Resolve play info for each vid in order.
   * @param options.deferred When given, a transient failure after retries is recorded under its vid and the lookup continues.
   * @returns Resolved media by vid; deferred vids are absent.
   */
  async videoUrls(ids, signal, seriesId, options = {}) {
    const engine = this.load(), result = new Map();
    lookup: for (const vid of ids) {
      let info;
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        // A retry bypasses the upstream 30-second play-info cache, as the upstream client does.
        info = await engine.fetchPlayUrlSingle(vid, seriesId, { quality: this.config.quality, signal, ...(attempt ? { force: true } : {}) });
        signal.throwIfAborted();
        if (info?.url && !info.locked && String(info.vid) === vid) break;
        const failures = sourceFailures(info), transient = !info?.url && transientFailure(info, failures);
        if (!transient || attempt >= this.config.sourceRetries) {
          const error = unavailable(info, failures, transient);
          if (!transient || !options.deferred) throw error;
          options.deferred.set(vid, error);
          continue lookup;
        }
        await sleep(this.config.sourceRetryDelayMs * (attempt + 1), undefined, { signal });
      }
      if (this.config.quality !== 'auto' && Number(info.width) > 0 && Number(info.height) > 0
        && Math.min(Number(info.width), Number(info.height)) < (this.config.quality === '1080p' ? 1080 : 720)) {
        throw new DownloadError('quality_unavailable', '来源没有返回请求清晰度的完整片源；未下载或降级', { sourceStage: 'video_model', retryable: false });
      }
      if (info.codec === 'bytevc2' && !this.config.bytevc2Executable) throw new DownloadError('missing_bytevc2_runtime', '此片源使用 ByteVC2；请更新 Muse 或配置 bytevc2Executable，未下载或降级', { retryable: false });
      if (info.codec === 'bytevc2' && (!Number.isFinite(Number(info.duration)) || Number(info.duration) <= 0
        || !Number.isSafeInteger(Number(info.width)) || Number(info.width) <= 0 || !Number.isSafeInteger(Number(info.height)) || Number(info.height) <= 0)) {
        throw new DownloadError('invalid_source_metadata', 'ByteVC2 来源缺少有效时长或画面尺寸；未下载或转换', { retryable: false });
      }
      const key = info.contentKey || (info.spadeA ? engine.deriveKey(info.spadeA)?.toString('hex') : null);
      if ((info.spadeA && !key) || (key && !/^[a-f\d]{32}$/i.test(key))) throw new DownloadError('invalid_key', '片源解密信息无效', { retryable: false });
      result.set(vid, { url: info.url, expectedBytes: null, headers: { 'user-agent': info.userAgent || engine.UA,
        ...(info.referer ? { referer: info.referer } : {}) }, encryption: key ? { contentKey: key } : null,
        expectedWidth: Number(info.width) || null, expectedHeight: Number(info.height) || null,
        expectedDuration: Number(info.duration) || null, quality: this.config.quality, codec: info.codec ?? null });
    }
    return result;
  }
}
