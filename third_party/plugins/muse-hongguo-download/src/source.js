/** Complete Hongguo catalogs and exact-episode media models with private local source configuration. */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { officialRequest, checkedUrl } from './network.js';
import { seriesId } from './parser.js';
import { DownloadError, safeError } from './errors.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const mediaPath = '/reading/bookapi/video_tab/multi_video_model/v1/';
const nativeSignatureHeaders = new Set(['x-argus', 'x-gorgon', 'x-khronos', 'x-ladon', 'x-helios', 'x-medusa', 'x-neptune', 'x-soter']);

/** Preserve decimal platform and device ids beyond JavaScript's exact integer range. */
function parseSourceJson(text) {
  return JSON.parse(text, (_key, value, context) => typeof value === 'number' && Number.isInteger(value)
    && !Number.isSafeInteger(value) && /^-?\d+$/.test(context.source) ? context.source : value);
}

class SourceRetryError extends DownloadError {
  constructor(details) { super('platform_error', '红果原源 API 返回错误；本次源请求重试已用尽，没有生成下载成功结果', details); }
}

/** Both platform response envelopes can report failure; a zero in one cannot hide another error. */
function sourceStatus(result, sourceStage) {
  const values = [result.code, result.Code, result.BaseResp?.StatusCode].filter(value => value !== undefined && value !== null);
  const codes = values.map(value => typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value);
  if (codes.some(code => !Number.isSafeInteger(code))) {
    throw new DownloadError('platform_json', '原源平台错误码格式无效', { sourceStage, retryable: false });
  }
  const failures = [...new Set(codes.filter(code => code !== 0))];
  if (failures.length > 1) throw new DownloadError('platform_json', '原源平台返回相互冲突的错误码', { sourceStage, retryable: false });
  return failures[0];
}

async function jsonFile(path) {
  if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('原源配置文件超过 2 MiB');
  const value = parseSourceJson(await readFile(path, 'utf8'));
  return value;
}

/** Read bounded streaming bytes, refusing HTTP errors and encoded/truncated bodies. */
export async function responseBytes(response, limit, signal) {
  try {
    if (response.statusCode !== 200) throw new DownloadError('http_error', `平台返回 HTTP ${response.statusCode}`, { httpStatus: response.statusCode });
    const encoding = response.headers['content-encoding'];
    if (encoding && encoding !== 'identity') throw new DownloadError('encoding', '平台返回不支持的传输编码');
    const length = response.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new DownloadError('response_size', '平台响应超过大小上限');
    const chunks = []; let size = 0;
    for await (const chunk of response) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > limit) throw new DownloadError('response_size', '平台响应超过大小上限');
      chunks.push(chunk);
    }
    if (length && size !== Number(length)) throw new DownloadError('incomplete_response', '平台响应不完整');
    return Buffer.concat(chunks);
  } catch (error) {
    if (signal.aborted || error instanceof DownloadError) throw error;
    throw new DownloadError('incomplete_response', '平台响应读取中断；没有取得完整来源数据');
  } finally { response.destroy(); }
}

function localSigner(url, payload, token, signal) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = httpRequest(url, { method: 'POST', signal, headers: {
      'content-type': 'application/json', 'content-length': body.length,
      ...(token ? { 'x-sign-token': token } : {}),
    } }, resolve);
    req.on('error', error => reject(signal.aborted ? signal.reason : new DownloadError('signer', `本地原签名器请求失败（${error.code ?? 'network'}）`)));
    req.end(body);
  });
}

/** Original config/session/device fields stay local and never appear in tool output. */
export class SourceCatalog {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.request = dependencies.request ?? officialRequest;
    this.sign = dependencies.sign ?? localSigner;
    this.randomIndex = dependencies.randomIndex ?? randomInt;
    this.signer = dependencies.signer ?? null;
    this.bootstrap = dependencies.bootstrap ?? null;
    this.loaded = null;
    this.deviceIndex = null;
    this.mediaGate = Promise.resolve();
    this.nextMediaRequestAt = 0;
    this.mediaBlockedUntil = 0;
    this.mediaResolved = false;
    this.now = dependencies.now ?? (() => performance.now());
    this.wait = dependencies.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  }

  /** Load only the explicitly configured original legacy directory. */
  async load(signal = new AbortController().signal) {
    if (this.loaded) return this.loaded;
    const directory = this.config.legacyAppDir;
    if (!directory || !isAbsolute(directory)) throw new DownloadError('missing_original_source', '本地红果原源运行环境未配置：Muse 内置工具需要包含原源运行时的安装包；独立插件请配置 legacyAppDir（config.json、devices.json）');
    if (this.bootstrap) await this.bootstrap.ensure(signal);
    let source, devices;
    try {
      source = await jsonFile(join(directory, 'config.json'));
      devices = await jsonFile(join(directory, 'devices.json'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new DownloadError('missing_original_source', '本地红果原源运行环境不完整：缺少 config.json 或 devices.json；请检查 Muse 安装包运行时或独立插件的 legacyAppDir');
      throw new DownloadError('invalid_original_source', '原源配置无法读取或格式无效');
    }
    if (!record(source) || typeof source.api_host !== 'string' || !record(source.base_query) || !Object.keys(source.base_query).length
      || !record(source.session_headers) || !Array.isArray(devices) || !devices.length
      || devices.some(device => !record(device) || !record(device.query))) throw new DownloadError('invalid_original_source', '原源 API/设备配置字段不完整');
    const api = new URL(`https://${source.api_host}/`);
    if (api.host !== source.api_host || api.username || api.password) throw new DownloadError('invalid_original_source', '原源 api_host 无效');
    checkedUrl(api.href, 'api', [api.hostname]);
    const signer = this.config.signServer;
    if (!signer && !this.signer) throw new DownloadError('missing_original_signer', '缺少原签名器：请配置本机 Java 17 和原签名素材，或配置 signServer');
    const signUrl = signer ? new URL(signer) : null;
    if (signUrl && (signUrl.protocol !== 'http:' || signUrl.hostname !== '127.0.0.1' || !signUrl.port || signUrl.username || signUrl.password
      || signUrl.search || signUrl.hash || (signUrl.pathname !== '/' && signUrl.pathname !== ''))) {
      throw new DownloadError('invalid_original_signer', 'signServer 必须是显式端口的 http://127.0.0.1 本地原签名器地址');
    }
    const headers = Object.fromEntries(Object.entries(source.session_headers).filter(([key, value]) => typeof value === 'string' && value
      && !['cookie', 'x-tt-token'].includes(key.toLowerCase())));
    this.deviceIndex ??= this.randomIndex(devices.length);
    this.loaded = { source, devices, headers, api, signUrl: signUrl ? new URL('/sign', signUrl).href : null };
    return this.loaded;
  }

  /** Report readiness without disclosing cookies, signing tokens, device ids or query fields. */
  async status() {
    try { await this.load(); return { configured: true, source: 'original-hongguo-api', verifiedLive: false, missing: [] }; }
    catch (error) { return { configured: false, source: 'original-hongguo-api', verifiedLive: false, missing: [safeError(error).message] }; }
  }

  /** Bound transient read-only retries on the retained device; only explicit risk replies can rotate it. */
  async api(path, body, signal, method = 'POST', params = {}) {
    let emptyRetried = false;
    for (let attempt = 0; ; attempt++) {
      const mediaRequest = path === mediaPath;
      const release = mediaRequest ? await this.reserveMediaRequest(signal) : () => {};
      let active = signal;
      try {
        active = mediaRequest ? AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]) : signal;
        return await this.apiOnce(path, body, active, method, params);
      }
      catch (error) {
        if (signal.aborted) throw error;
        if (active.aborted) throw new DownloadError('source_timeout', '红果单集媒体请求超时；未完成批次已停止，请保留原配置检查来源状态',
          { sourceStage: 'video_model', retryable: false });
        const risk = error instanceof SourceRetryError;
        const readOnly = mediaRequest || method === 'GET' || path === '/novel/player/multi_video_detail/v1/';
        const transient = readOnly && error instanceof DownloadError && (['network', 'incomplete_response'].includes(error.code)
          || error.code === 'http_error' && (error.httpStatus === 429 || error.httpStatus >= 500));
        const emptyRecovery = mediaRequest && this.mediaResolved && !emptyRetried && error instanceof DownloadError
          && error.code === 'empty_source_response';
        if (!risk && !transient && !emptyRecovery) throw error;
        if (attempt >= this.config.retries) {
          if (transient) {
            error.retryable = false;
            error.sourceStage = mediaRequest ? 'video_model' : path.includes('multi_video_detail') ? 'catalog' : 'source_api';
          }
          throw error;
        }
        if (emptyRecovery) {
          emptyRetried = true;
          this.mediaBlockedUntil = this.now() + this.config.emptySourceCooldownMs;
        }
        if (risk && this.loaded.devices.length > 1) this.deviceIndex = (this.deviceIndex + 1) % this.loaded.devices.length;
      } finally { release(); }
      if (this.config.retryDelayMs) await delay(this.config.retryDelayMs, undefined, { signal });
    }
  }

  /** Wait for a serialized media reservation and return the callback that releases it after request settlement. */
  async reserveMediaRequest(signal) {
    const previous = this.mediaGate;
    let release;
    this.mediaGate = new Promise(resolve => { release = resolve; });
    try {
      await previous;
      signal.throwIfAborted();
      const remaining = Math.max(this.nextMediaRequestAt, this.mediaBlockedUntil) - this.now();
      if (remaining > 0) await this.wait(remaining, signal);
      signal.throwIfAborted();
      return () => {
        this.nextMediaRequestAt = this.now() + this.config.mediaRequestIntervalMs;
        release();
      };
    } catch (error) { release(); throw error; }
  }

  /** Preserve signed catalog requests; the video-tab protocol omits incompatible native signatures. */
  async apiOnce(path, body, signal, method, params) {
    const sourceStage = path.includes('video_model') ? 'video_model' : path.includes('multi_video_detail') ? 'catalog' : 'source_api';
    const { source, devices, headers, api, signUrl } = await this.load(signal);
    const device = devices[this.deviceIndex % devices.length];
    const url = new URL(path, api);
    for (const [key, value] of Object.entries({ ...source.base_query, ...device.query, ...params, _rticket: String(Date.now()) })) {
      url.searchParams.set(key, String(value));
    }
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const signedRequest = path !== mediaPath;
    const sourceHeaders = signedRequest ? headers : Object.fromEntries(Object.entries(headers)
      .filter(([name]) => !nativeSignatureHeaders.has(name.toLowerCase())));
    const requestHeaders = { ...sourceHeaders, 'user-agent': device.user_agent || headers['user-agent'] || 'HongguoDownloader/SourceRebuild',
      'content-type': 'application/json; charset=utf-8', ...(raw ? { 'x-ss-stub': createHash('md5').update(raw).digest('hex').toUpperCase() } : {}) };
    let signed = {};
    if (signedRequest) {
      const endpoint = this.signer ? await this.signer.ensure(signal)
        : { url: signUrl, token: process.env[this.config.signTokenEnv] || '' };
      const signedResponse = await this.sign(endpoint.url, { url: url.href, headers: requestHeaders }, endpoint.token, signal);
      try { signed = JSON.parse((await responseBytes(signedResponse, 128 * 1024, signal)).toString('utf8')); }
      catch (error) { if (error instanceof DownloadError || signal.aborted) throw error; throw new DownloadError('signer', '原签名器返回无效 JSON'); }
      if (!record(signed) || signed.error || Object.values(signed).some(value => typeof value !== 'string' && typeof value !== 'number')) {
        throw new DownloadError('signer', '原签名器返回无效签名');
      }
    }
    const response = await this.request(url.href, 'api', signal, { method, body: raw,
      allowedHosts: [api.hostname], headers: { ...requestHeaders, ...(raw ? { 'content-length': raw.length } : {}), ...Object.fromEntries(Object.entries(signed).map(([key, value]) => [key, String(value)])) } });
    const httpStatus = response.statusCode;
    const bytes = await responseBytes(response, this.config.maxResponseBytes, signal);
    const diagnostic = { sourceStage, retryable: false, httpStatus, responseBytes: bytes.length };
    if (!bytes.length) throw new DownloadError('empty_source_response',
      '红果原源接口返回空正文；本次来源请求未成功。请停止重复下载，保留本机设备配置并检查来源状态；不要自动重建设备或用试看代替全集', diagnostic);
    let result;
    try { result = parseSourceJson(bytes.toString('utf8')); }
    catch (error) { if (signal.aborted) throw error; throw new DownloadError('platform_json', '原源平台返回非空但无效的 JSON；请按失败阶段检查，不要立即重复下载', diagnostic); }
    if (!record(result)) throw new DownloadError('platform_error', '红果原源 API 返回错误；没有生成下载成功结果');
    const code = sourceStatus(result, sourceStage);
    const details = { ...(code !== undefined ? { upstreamCode: code } : {}), sourceStage, retryable: false };
    if ([101001, 401, 403, 1001, 8].includes(code)) throw new DownloadError('platform_error', '红果原源 API 返回业务错误；请检查失败阶段与错误码，不要立即重复下载', details);
    const messages = [result.message, result.Message, result.BaseResp?.StatusMessage].filter(value => typeof value === 'string').join(' ');
    if (/verify|captcha|risk|频繁|稍后|验证|rate limit|too many/i.test(messages)) throw new SourceRetryError(details);
    if (code !== undefined) throw new DownloadError('platform_error', '红果原源 API 返回业务错误；请检查失败阶段与错误码，不要立即重复下载', details);
    return result;
  }

  /** Return the original full episode list, rejecting gaps and mismatched series ids. */
  async episodes(id, signal) {
    seriesId(id);
    const result = await this.api('/novel/player/multi_video_detail/v1/', { biz_param: {
      detail_page_version: 0, disable_digg_stat: false, disable_video_relate_book: false, image_shrink_datas_str: '',
      need_all_video_definition: false, need_mp4_align: false, screen_width_px: '900', source: 7, use_os_player: false, use_server_dns: false,
    }, series_id: id }, signal);
    const detail = result.data?.[id];
    const video = detail?.video_data;
    if (!record(video) || !Array.isArray(video.video_list) || !video.video_list.length) throw new DownloadError('incomplete_catalog', '原源没有返回完整剧集列表');
    if (video.series_id !== undefined && String(video.series_id) !== id) throw new DownloadError('series_mismatch', '原源返回了其他剧集，下载已拒绝');
    const count = Number(video.episode_cnt ?? detail.episode_cnt);
    if (!Number.isSafeInteger(count) || count < 1) throw new DownloadError('unverified_episode_count', '原源未返回有效的声明总集数，不能确认全剧');
    if (video.video_list.length !== count) throw new DownloadError('incomplete_catalog', '原源返回集数与声明总集数不一致，不能下载为全剧');
    const episodes = video.video_list.map(item => {
      const index = Number(item?.vid_index);
      if (!record(item) || !Number.isSafeInteger(index) || index < 1 || typeof item.vid !== 'string' || !item.vid) {
        throw new DownloadError('incomplete_catalog', '原源集号/视频 ID 无效');
      }
      return { index, vid: item.vid, title: String(item.title ?? '').slice(0, 200), durationSeconds: Number(item.duration) || null };
    }).sort((a, b) => a.index - b.index);
    if (episodes.some((episode, index) => episode.index !== index + 1)
      || new Set(episodes.map(episode => episode.vid)).size !== episodes.length) throw new DownloadError('incomplete_catalog', '原源集号不连续或视频 ID 重复，不能确认全剧');
    return { seriesId: id, title: String(video.series_title || id).slice(0, 200), episodeCount: count, source: 'original-hongguo-api', episodes };
  }

  /** Resolve bounded batches through the current video-tab endpoint and accept only each requested ID's keyed model. */
  async videoUrls(vids, signal) {
    const out = new Map();
    const unique = [...new Set(vids)];
    for (let offset = 0; offset < unique.length; offset += this.config.mediaBatchSize) {
      const batch = unique.slice(offset, offset + this.config.mediaBatchSize);
      const result = await this.api(mediaPath, undefined, signal, 'GET', {
        video_id: batch.join(','), video_platform: '1024', need_all_video_definition: 'true',
        device_level: '3', detail_page_version: '0',
      });
      for (const vid of batch) {
        let model = result.data?.video_model_data?.[vid]?.video_model;
        if (typeof model === 'string') { try { model = parseSourceJson(model); } catch (error) { throw new DownloadError('platform_json', '原源视频模型 JSON 无效'); } }
        const choices = Array.isArray(model?.video_list) ? model.video_list : record(model?.video_list) ? Object.values(model.video_list) : [];
        const best = choices.filter(choice => record(choice) && typeof choice.main_url === 'string' && choice.main_url)
          .sort((a, b) => (Number(b.video_meta?.size) || 0) - (Number(a.video_meta?.size) || 0))[0];
        if (!best) throw new DownloadError('missing_episode_url', '原源某集没有媒体地址；整剧尚未完成');
        let encryption = null;
        if (best.encrypt_info?.encrypt) {
          const spade = best.encrypt_info.spade_a;
          if (typeof spade !== 'string' || !spade.trim() || Buffer.byteLength(spade, 'utf8') > 16 * 1024) {
            throw new DownloadError('encrypted_media', '原源加密媒体缺少有效的本地解密信息');
          }
          encryption = { spade };
        }
        let url = best.main_url;
        if (!url.startsWith('https://')) url = Buffer.from(url, 'base64').toString('utf8');
        checkedUrl(url, 'media', this.config.mediaHosts, this.config.mediaPorts);
        this.mediaResolved = true;
        out.set(vid, { url, expectedBytes: Number(best.video_meta?.size) || null, sha256: null, encryption });
      }
    }
    return out;
  }
}
