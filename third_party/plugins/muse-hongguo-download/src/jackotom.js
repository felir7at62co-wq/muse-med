/** Pinned upstream catalog and playback adapter; private playback data stays inside the plugin. */
import { createRequire } from 'node:module';
import { DownloadError } from './errors.js';
const require = createRequire(import.meta.url);
const revision = 'bb4aec994a1fc6336da55b269481ae2196124e8d';

/** Adapt the upstream catalog to Muse's validated download and recovery pipeline. */
export class JackotomSource {
  constructor(config, engine) {
    this.config = config;
    this.engine = engine;
    this.identity = `jackotom:${revision}:${config.quality}`;
  }
  load() { return this.engine ??= require('../upstream/engine.cjs'); }
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
  async videoUrls(ids, signal, seriesId) {
    const engine = this.load(), result = new Map();
    for (const vid of ids) {
      signal.throwIfAborted();
      const info = await engine.fetchPlayUrlSingle(vid, seriesId, { quality: this.config.quality, signal });
      signal.throwIfAborted();
      if (!info?.url || info.locked || String(info.vid) !== vid) {
        throw new DownloadError('source_unavailable', '红果未返回可用的完整分集片源；已停止请求，已验证文件保留', { sourceStage: 'video_model', retryable: false });
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
