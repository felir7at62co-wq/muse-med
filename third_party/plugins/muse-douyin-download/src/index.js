/** Session-scoped Muse tools for authorized Douyin data and verified media acquisition. */
import { downloadCommand, resolveConfig, runDownloader, runtimeUnavailable } from './runner.js';
import { dataProperties, projectDataResult, resolveDataArgs } from './data.js';

export { downloadCommand, resolveConfig, runDownloader, runtimeUnavailable } from './runner.js';
export { projectDataResult, resolveDataArgs } from './data.js';
export const name = 'muse-douyin-download';
export const inject = ['agents', 'tools', 'subprocess'];

const properties = {
  url: { type: 'string', description: 'User-selected Douyin HTTPS video URL, modal_id page, or share link' },
  urls: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' }, description: 'Several user-selected video/share links, checked and downloaded separately; mutually exclusive with url' },
  publicOnly: { type: 'boolean', description: 'Try public playback only; do not open the internal browser' },

};

/** Validate model-provided input before accessing credentials or spawning. @param {object} value Tool arguments. @returns {object} Validated arguments. */
export function validateArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Douyin arguments must be an object');
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(properties, key) || (properties[key].type === 'array' ? !Array.isArray(entry) : typeof entry !== properties[key].type)) throw new TypeError(`Invalid Douyin argument: ${key}`);
  }
  if ((value.url === undefined) === (value.urls === undefined)) throw new TypeError('Choose either url or urls');
  const links = value.urls || [value.url];
  if (!links.length || links.length > 100 || links.some(link => typeof link !== 'string' || !link.trim() || link.length > 8192)) throw new TypeError('Provide one to 100 Douyin video or share links');
  for (const link of links) {
    let url;
    try { url = new URL(link); } catch { throw new TypeError('Provide an official HTTPS video/share URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
      || !['v.douyin.com', 'www.douyin.com', 'www.iesdouyin.com'].includes(url.hostname)) throw new TypeError('Provide an official HTTPS video/share URL');
  }
  return value;
}

/** Register data and download tools; unload aborts and settles admitted operations. @param {object} ctx Cordis services. @param {object} config Deployment settings. */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config);
  const lifetime = new AbortController();
  const running = new Set();
  const dataProgress = new WeakMap();
  const summarizeData = (state, cancelled = false) => {
    const dataAvailable = state.items.filter(item => item.counts !== undefined).length;
    const downloaded = state.items.filter(item => item.download?.status === 'downloaded').length;
    return { status: cancelled || state.items.some(item => item.status !== 'ok')
      ? dataAvailable || downloaded ? 'partial' : 'blocked' : 'complete',
    ...(cancelled ? { cancelled: true } : {}), requested: state.requested, completed: state.items.length,
    dataAvailable, downloaded, items: state.items.map((item, index) => ({ index: index + 1, ...item })) };
  };
  const track = async operation => {
    running.add(operation);
    try { return await operation; } finally { running.delete(operation); }
  };
  const acquireVideo = async (agent, url, publicOnly, signal) => {
    signal.throwIfAborted();
    const unavailable = runtimeUnavailable(settings);
    if (unavailable) return unavailable;
    const workspace = agent.session.header.cwd;
    let result = await track(runDownloader(ctx.subprocess, settings, downloadCommand(settings, { url, publicOnly: true }, workspace), workspace, signal));
    signal.throwIfAborted();
    if (result.status === 'blocked' && !publicOnly
      && /PUBLIC_SHARE_MEDIA_UNAVAILABLE|PUBLIC_SHARE_REQUEST_FAILED|PUBLIC_MEDIA_DOWNLOAD_FAILED|LOGIN_OR_VERIFICATION_REQUIRED|ACCESS_RESTRICTED/.test(result.message || '')) {
      const browser = ctx.get('douyinBrowser');
      if (browser?.version === 2 || browser?.version === 3) result = await track(browser.download(agent, url, signal, settings.maxDownloadBytes));
      else result = { status: 'blocked', code: 'DESKTOP_HOST_REQUIRED', message: 'This plugin requires the matching MUSE Desktop browser download bridge for authorized playback.' };
    }
    return result;
  };
  ctx.effect(() => async () => { lifetime.abort(new Error('Douyin plugin unloaded')); await Promise.allSettled([...running]); }, 'douyin: settle downloads on unload');
  ctx.effect(() => ctx.tools.register({
    name: 'douyin_download',
    description: 'Download one or several user-selected Douyin video/share URLs into the current workspace and return file-backed receipts after full decoding. Public playback is tried first, then MUSE opens its internal official page automatically. Complete normal login or verification there if required; workspace-scoped Douyin login survives application restarts. No external browser profiles, Cookie files, DRM or verification bypass. Browser transport requires Desktop Host protocol 6. Report blocked or partial results accurately',
    parameters: { type: 'object', additionalProperties: false, properties: { ...properties, urls: { ...properties.urls, maxItems: settings.maxVideos } }, oneOf: [{ required: ['url'] }, { required: ['urls'] }] },
    output: { schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string', enum: ['downloaded', 'complete', 'partial', 'blocked'] } }, required: ['status'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: settings.timeoutMs * settings.maxVideos + 10000,
    async execute(raw, exec) {
      const args = validateArgs(raw);
      const agent = ctx.agents.requireInitiator();
      const signal = exec?.signal ? AbortSignal.any([exec.signal, lifetime.signal]) : lifetime.signal;
      const links = args.urls || [args.url];
      if (links.length > settings.maxVideos) throw new TypeError(`This deployment accepts at most ${settings.maxVideos} video links per call`);
      const unavailable = runtimeUnavailable(settings);
      if (unavailable) return args.url !== undefined ? unavailable : { status: 'blocked', requested: links.length, downloaded: 0,
        items: links.map((_url, index) => ({ index: index + 1, ...unavailable })) };
      const items = [];
      for (const url of links) {
        signal.throwIfAborted();
        try {
          items.push(await acquireVideo(agent, url, args.publicOnly === true, signal));
        }
        catch (error) {
          signal.throwIfAborted();
          if (args.url !== undefined) throw error;
          items.push({ status: 'blocked', message: error instanceof Error ? error.message : 'Douyin downloader failed before verification' });
        }
      }
      if (args.url !== undefined) return items[0];
      const downloaded = items.filter(item => item.status === 'downloaded').length;
      return { status: downloaded === items.length ? 'complete' : downloaded > 0 ? 'partial' : 'blocked',
        requested: links.length, downloaded, items: items.map((item, index) => ({ index: index + 1, ...item })) };
    },
    presentCall() { return { card: 'generic', title: '抖音视频下载', kind: 'execute' }; },
    presentResult(_args, result) { return { card: 'generic', title: '抖音视频下载', content: result.content }; },
  }), 'douyin: register video acquisition tool');
  ctx.effect(() => ctx.tools.register({
    name: 'douyin_data',
    description: 'Read one or several selected Douyin works’ public-page data or your normally signed-in creator-page data, in link order. Counts preserve missing values as null and mark rounded displays; public play counts require observed official page data, and placeholder zero remains unavailable. Creator data requires ordinary login and an exact own-work list row with its matching modification permission and statistics identity. Unavailable ownership returns CREATOR_OWNERSHIP_UNVERIFIED. A login is not OAuth authorization. Comment content and pagination currently return COMMENTS_UNAVAILABLE; an observed total comment count remains separate. A commentCursor applies to one link only. Complete normal login or verification in MUSE’s internal official Browser when required. No credentials, arbitrary browser profiles or signed requests are accepted. download:true reuses the existing verified Douyin downloader for each same link and includes its separate result. Report partial results, unavailable fields and blocked source/comment/download results accurately',
    parameters: { type: 'object', additionalProperties: false, properties: { ...dataProperties, urls: { ...dataProperties.urls, maxItems: settings.maxVideos }, commentLimit: { ...dataProperties.commentLimit, maximum: settings.maxComments } }, oneOf: [{ required: ['url'] }, { required: ['urls'] }] },
    output: { schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string', enum: ['ok', 'complete', 'partial', 'blocked'] } }, required: ['status'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: (settings.dataTimeoutMs + settings.requestTimeoutMs + settings.timeoutMs) * settings.maxVideos + 10000,
    async execute(raw, exec) {
      const request = resolveDataArgs(raw, settings);
      const signal = exec?.signal ? AbortSignal.any([exec.signal, lifetime.signal]) : lifetime.signal;
      signal.throwIfAborted();
      const agent = ctx.agents.requireInitiator();
      const state = { requested: request.urls.length, items: [], cancelled: false };
      if (exec !== undefined) dataProgress.set(exec, state);
      return await track((async () => {
        const browser = ctx.get('douyinBrowser');
        try {
          for (const url of request.urls) {
            signal.throwIfAborted();
            const selection = { url, source: request.source, comments: request.comments, timeoutMs: request.timeoutMs };
            let result;
            if (browser?.version !== 3) result = { status: 'blocked', code: 'DESKTOP_HOST_REQUIRED' };
            else {
              const deadline = new AbortController();
              const timer = setTimeout(() => deadline.abort(new Error('Douyin data request timed out')), settings.dataTimeoutMs + settings.requestTimeoutMs);
              const dataSignal = AbortSignal.any([signal, deadline.signal]);
              try {
                const answer = await browser.data(agent, selection, dataSignal);
                signal.throwIfAborted();
                if (deadline.signal.aborted) result = { status: 'blocked', code: 'TRANSPORT_TIMEOUT' };
                else {
                  try { result = projectDataResult(answer, selection); }
                  catch { result = { status: 'blocked', code: 'INVALID_RESULT' }; }
                }
              } catch {
                signal.throwIfAborted();
                result = { status: 'blocked', code: deadline.signal.aborted ? 'TRANSPORT_TIMEOUT' : 'HOST_UNAVAILABLE' };
              } finally { clearTimeout(timer); }
            }
            signal.throwIfAborted();
            const itemIndex = state.items.length;
            state.items.push(result);
            if (request.download) {
              let download;
              try {
                download = await acquireVideo(agent, url, false, signal);
                signal.throwIfAborted();
              } catch (error) {
                if (signal.aborted) {
                  state.items[itemIndex] = { ...result, status: result.counts !== undefined ? 'partial' : 'blocked', download: { status: 'blocked', code: 'CANCELLED' } };
                  throw error;
                }
                download = { status: 'blocked', code: 'DOWNLOAD_FAILED' };
              }
              result = { ...result, status: result.status === 'ok' && download.status === 'downloaded' ? 'ok'
                : result.counts !== undefined || download.status === 'downloaded' ? 'partial' : 'blocked', download };
              state.items[itemIndex] = result;
            }
          }
          return request.single ? state.items[0] : summarizeData(state);
        } catch (error) {
          state.cancelled = signal.aborted;
          throw error;
        }
      })());
    },
    finalizeContent(exec, result) {
      const state = dataProgress.get(exec);
      dataProgress.delete(exec);
      if (state?.cancelled && state.items.length) return [...result.content,
        { type: 'text', text: JSON.stringify(summarizeData(state, true), null, 2) }];
    },
    presentCall() { return { card: 'generic', title: '抖音作品数据', kind: 'execute' }; },
    presentResult(_args, result) { return { card: 'generic', title: '抖音作品数据', content: result.content }; },
  }), 'douyin: register page data tool');
}
