/** A session-scoped Muse tool for verified Douyin media acquisition. */
import { downloadCommand, resolveConfig, runDownloader, runtimeUnavailable } from './runner.js';

export { downloadCommand, resolveConfig, runDownloader, runtimeUnavailable } from './runner.js';
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

/** Register one tool; unload aborts and settles its active subprocesses. @param {object} ctx Cordis services. @param {object} config Deployment settings. */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config);
  const lifetime = new AbortController();
  const running = new Set();
  ctx.effect(() => async () => { lifetime.abort(new Error('Douyin plugin unloaded')); await Promise.allSettled([...running]); }, 'douyin: settle downloads on unload');
  ctx.effect(() => ctx.tools.register({
    name: 'douyin_download',
    description: 'Download one or several user-selected Douyin video/share URLs into the current workspace and return file-backed receipts after full decoding. Public playback is tried first, then MUSE opens its internal official page automatically. Complete normal login or verification there if required; workspace-scoped Douyin login survives application restarts. No external browser profiles, Cookie files, DRM or verification bypass. Browser transport requires Desktop Host protocol 5. Report blocked or partial results accurately',
    parameters: { type: 'object', additionalProperties: false, properties, oneOf: [{ required: ['url'] }, { required: ['urls'] }] },
    output: { schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string', enum: ['downloaded', 'complete', 'partial', 'blocked'] } }, required: ['status'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: settings.timeoutMs * settings.maxVideos + 10000,
    async execute(raw, exec) {
      const args = validateArgs(raw);
      const agent = ctx.agents.requireInitiator();
      const workspace = agent.session.header.cwd;
      const signal = exec?.signal ? AbortSignal.any([exec.signal, lifetime.signal]) : lifetime.signal;
      const links = args.urls || [args.url];
      if (links.length > settings.maxVideos) throw new TypeError(`This deployment accepts at most ${settings.maxVideos} video links per call`);
      const unavailable = runtimeUnavailable(settings);
      if (unavailable) return args.url !== undefined ? unavailable : { status: 'blocked', requested: links.length, downloaded: 0,
        items: links.map((_url, index) => ({ index: index + 1, ...unavailable })) };
      const items = [];
      for (const url of links) {
        signal.throwIfAborted();
        const pending = runDownloader(ctx.subprocess, settings, downloadCommand(settings, { url, publicOnly: true }, workspace), workspace, signal);
        running.add(pending);
        try {
          let result = await pending;
          if (result.status === 'blocked' && args.publicOnly !== true
            && /PUBLIC_SHARE_MEDIA_UNAVAILABLE|PUBLIC_SHARE_REQUEST_FAILED|PUBLIC_MEDIA_DOWNLOAD_FAILED|LOGIN_OR_VERIFICATION_REQUIRED|ACCESS_RESTRICTED/.test(result.message || '')) {
            const browser = ctx.get('douyinBrowser');
            if (browser?.version === 1) {
              const nativePending = browser.download(agent, url, signal);
              running.add(nativePending);
              try { result = await nativePending; } finally { running.delete(nativePending); }
            } else result = { status: 'blocked', code: 'DESKTOP_HOST_REQUIRED', message: 'This plugin requires the matching MUSE Desktop browser download bridge for authorized playback.' };
          }
          items.push(result);
        }
        catch (error) {
          signal.throwIfAborted();
          if (args.url !== undefined) throw error;
          items.push({ status: 'blocked', message: error instanceof Error ? error.message : 'Douyin downloader failed before verification' });
        } finally { running.delete(pending); }
      }
      if (args.url !== undefined) return items[0];
      const downloaded = items.filter(item => item.status === 'downloaded').length;
      return { status: downloaded === items.length ? 'complete' : downloaded > 0 ? 'partial' : 'blocked',
        requested: links.length, downloaded, items: items.map((item, index) => ({ index: index + 1, ...item })) };
    },
    presentCall() { return { card: 'generic', title: '抖音视频下载', kind: 'execute' }; },
    presentResult(_args, result) { return { card: 'generic', title: '抖音视频下载', content: result.content }; },
  }), 'douyin: register video acquisition tool');
}
