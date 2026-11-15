/** Public compatibility media retains explicit open scope and the normal MP4/decode receipt checks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HongguoDownloadClient } from '../src/client.js';
import { parsePlayer, parsePublicPlayback } from '../src/parser.js';

const id = '7702763145030290457', vids = ['7702763200000000001', '7702763200000000002'];
const mediaUrl = 'https://v1-hgweb.qznovelvod.com/fixture?token=PUBLIC_PRIVATE_MARKER';
const box = (type, bytes = Buffer.alloc(0)) => { const header = Buffer.alloc(8); header.writeUInt32BE(bytes.length + 8); header.write(type, 4); return Buffer.concat([header, bytes]); };
const plain = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', box('trak', box('mdia'))), box('mdat', Buffer.from('fixture public media'))]);
const reply = (body, statusCode = 200, headers = {}) => {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return Object.assign(Readable.from([bytes]), { statusCode, headers: { 'content-length': String(bytes.length), ...headers } });
};
const playback = () => ({ main_url: mediaUrl, url_expire: 3600, base_resp: { StatusCode: 0, StatusMessage: '' } });
const signal = () => new AbortController().signal;
const page = (route, extraRoutes) => `window._ROUTER_DATA = ${JSON.stringify({ loaderData: { ...route, ...extraRoutes } })};`;
function routeData({ episode = 1, accessible = 1, videoIds = vids, fields, childWithoutSeo = true } = {}) {
  return { isSuccess: true, series_id: id, vid: videoIds[episode - 1], protectedPlayback: true,
    seriesDetail: { series_id: id, series_name: '公开范围样例', episode_cnt: videoIds.length,
      accessible_episode_cnt: accessible, vid_list: videoIds },
    ...episode > 1 && childWithoutSeo ? {} : { publicVideoSeo: { available: true, seriesId: id,
      itemId: videoIds[episode - 1], durationSeconds: 10, width: 640, height: 360, posterUrl: 'https://example.org/poster.jpg' } },
    ...fields };
}
function html(options) {
  return page({ [options?.episode > 1 ? 'player_(series_id)/(vid)/page' : 'player_(series_id)/page']: routeData(options) });
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-public-fallback-')), calls = [];
  let processed = 0;
  const client = new HongguoDownloadClient({ sourceMode: 'public', outputRoot: root, retries: options.retries ?? 0,
    requestTimeoutMs: options.requestTimeoutMs ?? 20000 }, {
    request: async (url, kind, active, requestOptions = {}) => {
      active.throwIfAborted();
      calls.push({ url, kind, options: requestOptions });
      if (kind === 'media') return reply(options.media ?? plain, 200, { 'content-type': 'video/mp4' });
      const parsed = new URL(url);
      if (parsed.pathname === '/api/video/protected/fallback-play-info') {
        return options.fallback ? options.fallback(active, requestOptions) : reply(playback());
      }
      const item = parsed.pathname.split('/')[3];
      const episode = item === undefined ? 1 : vids.indexOf(decodeURIComponent(item)) + 1;
      assert.ok(episode >= 1, 'public routes use the known item ID, not an invented episode-number path');
      return reply(options.player ? options.player(episode, calls) : html({ episode, accessible: options.accessible ?? 1, fields: options.fields }));
    },
    processMedia: async (media, { inputPath }) => {
      processed++;
      assert.equal(media.encryption, undefined, 'public compatibility never enters the original offline decrypt path');
      return { processedPath: inputPath, durationSeconds: 10, fullDecodeChecked: options.fullDecodeChecked ?? true,
        validationLevel: 'ffprobe-full-decode-sha256' };
    },
  });
  t.after(async () => { try { await client.dispose(); } finally { await rm(root, { recursive: true, force: true }); } });
  return { root, client, calls, processed: () => processed };
}

test('catalog mode accepts a complete declared directory without a media model or fallback request', async t => {
  const f = await fixture(t, { fields: { protectedPlayback: undefined, publicVideoSeo: undefined } });
  const result = await f.client.info({ seriesIds: [id] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map(item => [item.episodeCount, item.accessibleEpisodeCount, item.mediaUrlsVerified, item.fullSeriesAvailable]), [[2, 1, false, false]]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].kind, 'page');
  assert.equal(f.processed(), 0);
  assert.deepEqual(await readdir(f.root), []);
});

test('current protected SSR schedules only ordinary fallback and does not return the protected URL as media', () => {
  const result = parsePlayer(html(), id, 1);
  assert.deepEqual(result.publicFallback, { itemId: vids[0] });
  assert.equal(result.mediaUrl, null);
  assert.equal(result.info.durationSeconds, 10);
});

test('one open episode uses exact anonymous POST and publishes only verified MP4 facts', async t => {
  const f = await fixture(t), result = await f.client.download({ seriesIds: [id], episodes: [1] });
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(result.fullDecodeChecked, true);
  const post = f.calls.filter(call => new URL(call.url).pathname === '/api/video/protected/fallback-play-info');
  assert.equal(post.length, 1);
  assert.equal(post[0].url, 'https://hongguoduanju.com/api/video/protected/fallback-play-info?aid=8662');
  assert.equal(post[0].kind, 'page');
  assert.equal(post[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(post[0].options.body), { item_id: vids[0] });
  assert.equal(post[0].options.headers['x-xs-from-web'], '1');
  assert.equal(post[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(Object.keys(post[0].options.headers).sort(), ['accept', 'content-length', 'content-type', 'x-xs-from-web']);
  assert.equal(f.calls.some(call => /protected\/play-info/u.test(call.url)), false);
  assert.equal(f.calls.filter(call => call.kind === 'media').length, 1);
  const episode = result.items[0].episodes[0];
  assert.equal(episode.encryptedSource, false);
  assert.equal(episode.sha256, createHash('sha256').update(plain).digest('hex'));
  assert.deepEqual(await readFile(episode.path), plain);
  for (const value of [result, JSON.parse(await readFile(result.checkpoint, 'utf8')),
    JSON.parse(await readFile(join(result.path, 'download-manifest.json'), 'utf8'))]) {
    assert.equal(JSON.stringify(value).includes('PUBLIC_PRIVATE_MARKER'), false);
    assert.equal(JSON.stringify(value).includes(mediaUrl), false);
  }
});

test('an open nested item route may omit SEO duration but must match its declared item and open boundary', async t => {
  const f = await fixture(t, { accessible: 2 }), result = await f.client.download({ seriesIds: [id], episodes: [2] });
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(result.items[0].episodes[0].index, 2);
  assert.ok(f.calls.some(call => new URL(call.url).pathname === `/player/${id}/${vids[1]}`));
  const post = f.calls.find(call => new URL(call.url).pathname === '/api/video/protected/fallback-play-info');
  assert.deepEqual(JSON.parse(post.options.body), { item_id: vids[1] });
  const parsed = parsePlayer(html({ episode: 2, accessible: 2 }), id, 2);
  assert.equal(parsed.info.durationSeconds, null);
});

for (const episodes of [undefined, [2]]) test(`closed requested scope ${JSON.stringify(episodes)} never reaches fallback or media`, async t => {
  const f = await fixture(t), result = await f.client.download({ seriesIds: [id], ...episodes === undefined ? {} : { episodes } });
  assert.equal(result.ok, false); assert.equal(result.code, 'public_preview_only');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await readdir(f.root), []);
});

for (const [name, fields] of [
  ['wrong series', { publicVideoSeo: { available: true, seriesId: '999', itemId: vids[0], durationSeconds: 10 } }],
  ['wrong item', { publicVideoSeo: { available: true, seriesId: id, itemId: vids[1], durationSeconds: 10 } }],
  ['missing first SEO', { publicVideoSeo: undefined }], ['wrong protection flag', { protectedPlayback: 'true' }],
]) test(`${name} cannot schedule fallback or use an unrelated embedded address`, async t => {
  const f = await fixture(t, { fields: { ...fields, video_player_info: { main_url: mediaUrl, duration: 10 } } });
  const result = await f.client.download({ seriesIds: [id], episodes: [1] });
  assert.equal(result.code, 'invalid_player');
  assert.equal(f.calls.some(call => call.options.method === 'POST' || call.kind === 'media'), false);
});

test('unknown first playback format is not guessed to be ordinary fallback', async t => {
  const f = await fixture(t, { fields: { protectedPlayback: undefined, publicVideoSeo: undefined } });
  const result = await f.client.download({ seriesIds: [id], episodes: [1] });
  assert.equal(result.code, 'invalid_player');
  assert.equal(f.calls.some(call => call.options.method === 'POST' || call.kind === 'media'), false);
});

test('old embedded first-episode ordinary media remains usable without a compatibility POST', async t => {
  const f = await fixture(t, { fields: { protectedPlayback: undefined, publicVideoSeo: undefined,
    video_player_info: { main_url: mediaUrl, duration: 10 } } });
  const result = await f.client.download({ seriesIds: [id], episodes: [1] });
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(f.calls.filter(call => call.kind === 'media').length, 1);
  assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
});

test('a legacy embedded address cannot override explicitly unavailable SEO', async t => {
  const f = await fixture(t, { fields: { protectedPlayback: false,
    publicVideoSeo: { available: false, seriesId: id, itemId: vids[0] },
    video_player_info: { main_url: mediaUrl, duration: 10 } } });
  const result = await f.client.download({ seriesIds: [id], episodes: [1] });
  assert.equal(result.code, 'public_preview_only');
  assert.equal(f.calls.some(call => call.options.method === 'POST' || call.kind === 'media'), false);
});

for (const available of [false, true]) test(`nested SEO remains authoritative when present (available=${available})`, async t => {
  const f = await fixture(t, { accessible: 2, player: episode => html({ episode, accessible: 2, childWithoutSeo: false,
    fields: episode === 1 ? undefined : { publicVideoSeo: { available, seriesId: id,
      itemId: available ? vids[0] : vids[1], durationSeconds: 10 } } }) });
  const result = await f.client.download({ seriesIds: [id], episodes: [2] });
  assert.equal(result.code, available ? 'invalid_player' : 'public_preview_only');
  assert.equal(f.calls.some(call => call.options.method === 'POST' || call.kind === 'media'), false);
});

test('explicit unavailable SEO blocks even an episode inside the declared accessible range', async t => {
  const f = await fixture(t, { fields: { publicVideoSeo: { available: false, seriesId: id, itemId: vids[0] } } });
  const result = await f.client.download({ seriesIds: [id], episodes: [1] });
  assert.equal(result.code, 'public_preview_only');
  assert.equal(f.calls.some(call => call.options.method === 'POST' || call.kind === 'media'), false);
});

test('different known route payloads are ambiguous and cannot authorize another player', () => {
  assert.throws(() => parsePlayer(page({ 'player_(series_id)/page': routeData() },
    { 'player_(series_id)/(vid)/page': routeData({ episode: 2, accessible: 2 }) }), id, 1), /冲突/u);
});

test('a catalog whose selected item changes before resolution is refused before the fallback POST', async t => {
  const f = await fixture(t, { player: (_episode, calls) => calls.length === 1 ? html()
    : html({ videoIds: ['changed-current', vids[1]] }) });
  const result = await f.client.download({ seriesIds: [id], episodes: [1] });
  assert.equal(result.code, 'invalid_player');
  assert.equal(f.calls.some(call => call.options.method === 'POST' || call.kind === 'media'), false);
});

for (const [name, value, code] of [
  ['missing explicit status', { main_url: mediaUrl, code: 0 }, 'platform_json'],
  ['failed lowercase envelope', { ...playback(), base_resp: { StatusCode: 1001, StatusMessage: 'PUBLIC_PRIVATE_MARKER' } }, 'platform_error'],
  ['failed root code', { ...playback(), code: 403 }, 'platform_error'],
  ['failed upper envelope', { ...playback(), BaseResp: { StatusCode: '403' } }, 'platform_error'],
  ['conflicting codes', { ...playback(), Code: 403, code: 1001 }, 'platform_json'],
  ['malformed status', { ...playback(), base_resp: { StatusCode: true } }, 'platform_json'],
  ['missing URL', { base_resp: { StatusCode: 0 } }, 'missing_episode_url'],
  ['base64 URL', { ...playback(), main_url: Buffer.from(mediaUrl).toString('base64') }, 'platform_json'],
  ['HTTP URL', { ...playback(), main_url: 'http://v1-hgweb.qznovelvod.com/fixture' }, 'unsafe_url'],
  ['credential URL', { ...playback(), main_url: 'https://user:pass@v1-hgweb.qznovelvod.com/fixture' }, 'unsafe_url'],
  ['wrong item echo', { ...playback(), item_id: vids[1] }, 'platform_json'],
  ['key model', { ...playback(), key: 'PUBLIC_PRIVATE_MARKER' }, 'unsupported_public_playback'],
  ...['player_access_key', 'kid', 'play_info', 'drm', 'license', 'key_server'].map(field => [
    `${field} protection model`, { ...playback(), [field]: 'PUBLIC_PRIVATE_MARKER' }, 'unsupported_public_playback']),
  ['audio tracks', { ...playback(), audio: { main_url: mediaUrl } }, 'unsupported_public_playback'],
  ['DASH model', { ...playback(), video_model: { main_url: mediaUrl } }, 'unsupported_public_playback'],
  ['bad expiry type', { ...playback(), url_expire: 'unknown' }, 'platform_json'],
]) test(`${name} is an explicit safe failure instead of an ordinary media model`, async t => {
  const f = await fixture(t, { fallback: async () => reply(value), retries: 2 });
  const result = await f.client.download({ seriesIds: [id], episodes: [1] });
  assert.equal(result.code, code); assert.equal(result.ok, false); assert.equal(result.complete, false);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(f.calls.some(call => call.kind === 'media'), false);
  assert.equal(JSON.stringify(result).includes('PUBLIC_PRIVATE_MARKER'), false);
  assert.equal((await readdir(result.path, { recursive: true })).some(path => path.endsWith('.part')), false);
});

test('zero status cannot be hidden behind contradictory or invalid business codes', () => {
  for (const value of [null, [], { ...playback(), code: null }, { ...playback(), Code: '9007199254740993' },
    { ...playback(), BaseResp: {} }, { ...playback(), base_resp: { status_code: 0 } }]) {
    assert.throws(() => parsePublicPlayback(value, vids[0]), error => error.code === 'platform_json' && error.retryable === false);
  }
});

test('URL expiry is not guessed to be an absolute timestamp and plain success never receives decryption fields', () => {
  assert.equal(parsePublicPlayback(playback(), vids[0]), mediaUrl);
});

for (const [name, body, code] of [['empty', Buffer.alloc(0), 'empty_source_response'],
  ['HTML', '<html>PUBLIC_PRIVATE_MARKER</html>', 'platform_json'], ['broken JSON', '{"main_url":', 'platform_json']]) {
  test(`${name} fallback response fails without media and without raw response text`, async t => {
    const f = await fixture(t, { fallback: async () => reply(body) }), result = await f.client.download({ seriesIds: [id], episodes: [1] });
    assert.equal(result.code, code);
    assert.equal(result.sourceStage, 'video_model');
    assert.equal(result.retryable, false);
    assert.equal(result.httpStatus, 200);
    assert.equal(f.calls.some(call => call.kind === 'media'), false);
    assert.equal(JSON.stringify(result).includes('PUBLIC_PRIVATE_MARKER'), false);
  });
}

test('media host allowlists still reject a successful API response before any CDN request', async t => {
  const f = await fixture(t, { fallback: async () => reply({ ...playback(), main_url: 'https://unconfigured.example.org/media' }) });
  const result = await f.client.download({ seriesIds: [id], episodes: [1] });
  assert.equal(result.code, 'unsafe_url');
  assert.equal(f.calls.some(call => call.kind === 'media'), false);
});

for (const [name, media, code] of [
  ['HLS bytes', Buffer.from('#EXTM3U\n#EXTINF:10\nsegment.ts'), 'invalid_media'],
  ['encrypted MP4', Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', box('encv')), box('mdat', Buffer.from('ciphertext'))]), 'encrypted_media'],
]) test(`${name} fails the existing ordinary-media guard and never enters offline decryption`, async t => {
  const f = await fixture(t, { media }), result = await f.client.download({ seriesIds: [id], episodes: [1] });
  assert.equal(result.code, code); assert.equal(result.complete, false);
  assert.equal(f.processed(), 0);
  assert.equal((await readdir(result.path, { recursive: true })).some(path => path.endsWith('.part')), false);
});

test('a codec seam without full decoding cannot publish a successful public receipt', async t => {
  const f = await fixture(t, { fullDecodeChecked: false }), result = await f.client.download({ seriesIds: [id], episodes: [1] });
  assert.equal(result.code, 'invalid_media'); assert.equal(result.complete, false);
  assert.equal((await readdir(result.path)).includes('download-manifest.json'), false);
});

test('caller cancellation and owner disposal stop an in-flight fallback lookup without media requests', async t => {
  const entered = Promise.withResolvers();
  const f = await fixture(t, { fallback: async active => {
    entered.resolve();
    await new Promise((resolve, reject) => active.addEventListener('abort', () => reject(active.reason), { once: true }));
    throw Error('unreachable');
  } });
  const controller = new AbortController(), pending = f.client.download({ seriesIds: [id], episodes: [1] }, controller.signal);
  await entered.promise;
  controller.abort();
  const result = await pending;
  await f.client.dispose();
  assert.equal(result.code, 'cancelled');
  assert.equal(f.calls.some(call => call.kind === 'media'), false);
});
