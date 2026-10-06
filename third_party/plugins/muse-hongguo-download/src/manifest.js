/** Authorized direct-media catalog format from runtime/app/remote.py in the supplied repair source. */
import { readFile, stat } from 'node:fs/promises';
import { checkedUrl } from './network.js';
import { DownloadError } from './errors.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Catalog entries are snapshots per call; source URLs remain private to the downloader. */
export class ManifestCatalog {
  constructor(config) { this.config = config; }

  async load() {
    if (!this.config.catalogPath) throw new DownloadError('missing_manifest', '未配置修复源码的授权媒体目录 catalogPath');
    let data;
    try {
      if ((await stat(this.config.catalogPath)).size > this.config.maxResponseBytes) throw new DownloadError('manifest_size', '授权媒体目录超过大小上限');
      data = JSON.parse(await readFile(this.config.catalogPath, 'utf8'));
    } catch (error) { if (error instanceof DownloadError) throw error; throw new DownloadError('invalid_manifest', '授权媒体目录无法读取或 JSON 无效'); }
    if (!record(data) || !Array.isArray(data.series) || !data.series.length || data.series.length > 1000) throw new DownloadError('invalid_manifest', '授权媒体目录必须包含 1–1000 项 series 数组');
    const ids = new Set();
    return data.series.map(row => {
      if (!record(row) || typeof row.series_id !== 'string' || !/^[\w\u4e00-\u9fff.-]{1,120}$/.test(row.series_id)
        || ids.has(row.series_id) || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 200
        || !Array.isArray(row.episodes) || !row.episodes.length) throw new DownloadError('invalid_manifest', '授权媒体目录系列 ID、标题或集数无效');
      ids.add(row.series_id);
      const count = row.episode_cnt ?? row.episodes.length;
      if (!Number.isSafeInteger(count) || count !== row.episodes.length) throw new DownloadError('incomplete_catalog', '授权媒体目录声明总集数与列表不一致');
      const episodes = row.episodes.map(episode => {
        if (!record(episode) || !Number.isSafeInteger(episode.index) || episode.index < 1
          || typeof episode.url !== 'string' || episode.url.length > 8192
          || (episode.sha256 !== undefined && (typeof episode.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(episode.sha256)))) throw new DownloadError('invalid_manifest', '授权媒体目录集号、地址或 SHA256 无效');
        checkedUrl(episode.url, 'media', this.config.mediaHosts, this.config.mediaPorts);
        return { index: episode.index, vid: `${row.series_id}:${episode.index}`, title: String(episode.title ?? `第 ${episode.index} 集`).slice(0, 200),
          durationSeconds: null, url: episode.url, sha256: episode.sha256?.toLowerCase() ?? null, expectedBytes: null };
      }).sort((a, b) => a.index - b.index);
      if (episodes.some((episode, index) => episode.index !== index + 1)) throw new DownloadError('incomplete_catalog', '授权媒体目录集号必须从 1 连续到声明总集数');
      return { seriesId: row.series_id, title: row.title, episodeCount: count, source: 'authorized-manifest', episodes };
    });
  }

  /** The catalog list defines the supplied manifest's coverage, not Hongguo platform coverage. */
  async episodes(id) {
    const row = (await this.load()).find(item => item.seriesId === id);
    if (!row) throw new DownloadError('series_not_found', '授权媒体目录中没有请求的系列');
    return row;
  }
}
