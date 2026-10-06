/** Owner-local transport fixtures exercise full lists, atomic files and cleanup without live credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HongguoDownloadClient, resolveConfig } from '../src/client.js';
import { apply } from '../src/index.js';
import { SourceCatalog } from '../src/source.js';
import { checkedUrl, isPublicAddress } from '../src/network.js';
import { parsePlayer } from '../src/parser.js';
import { DownloadError } from '../src/errors.js';

const box = (type, bytes = Buffer.alloc(0)) => { const header = Buffer.alloc(8); header.writeUInt32BE(bytes.length + 8); header.write(type, 4); return Buffer.concat([header, bytes]); };
const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', box('trak', box('mdia'))), box('mdat', Buffer.from('fixture payload'))]);
const sha256 = createHash('sha256').update(mp4).digest('hex');
const reply = (body, status = 200, headers = {}) => Object.assign(Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]), { statusCode: status, headers });
const emptySignal = () => new AbortController().signal;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// The toy MP4 exercises real container validation; the codec seam supplies a controlled verdict.
const fixtureProcessMedia = async (_media, { inputPath }) => ({ processedPath: inputPath, durationSeconds: 10,
  fullDecodeChecked: true, validationLevel: 'ffprobe-full-decode-sha256' });

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-hongguo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = join(root, 'legacy'); await mkdir(legacy);
  await writeFile(join(legacy, 'config.json'), JSON.stringify({ api_host: 'api.example.org', base_query: { app: 'test-device' }, session_headers: extra.sessionHeaders ?? { cookie: 'SESSION_PRIVATE' } }));
  await writeFile(join(legacy, 'devices.json'), JSON.stringify(extra.devices ?? [{ query: { device: 'PRIVATE_DEVICE' }, user_agent: 'fixture' }]));
  const batches = [], urls = [], signs = [];
  let media = extra.media ?? mp4;
  const request = async (value, kind, signal, options = {}) => {
    signal.throwIfAborted();
    const url = new URL(value); urls.push({ value, kind, options });
    if (kind === 'media') return typeof media === 'function' ? media(value, signal) : reply(media, 200, { 'content-length': String(media.length), 'content-type': 'video/mp4' });
    const body = JSON.parse(options.body);
    if (url.pathname.includes('multi_video_detail')) {
      const id = body.series_id;
      const count = extra.count ?? 7;
      return reply({ code: 0, data: { [id]: { video_data: { series_id: id, series_title: `标题${id}`, episode_cnt: extra.declaredCount ?? count,
        video_list: Array.from({ length: count }, (_, index) => ({ vid_index: String(index + 1), vid: `${id}v${index + 1}`, title: `集${index + 1}` })) } } } });
    }
    const vids = body.mixed_video_id_map['1']; batches.push(vids);
    return reply({ data: Object.fromEntries(vids.map(vid => [vid, { video_model: JSON.stringify({ video_list: [{ main_url: Buffer.from(extra.mediaUrl?.(vid, batches.length) ?? `https://v1.qznovelvod.com/${vid}?token=MEDIA_SECRET`).toString('base64'), video_meta: { size: extra.expectedBytes ?? mp4.length }, encrypt_info: extra.encryptInfo }] }) }])) });
  };
  const config = { legacyAppDir: legacy, signServer: 'http://127.0.0.1:8123', outputRoot: root, retries: 0, retryDelayMs: 0, ...extra.config };
  const sign = async (url, payload, token) => { signs.push({ url, payload, token }); return reply({ 'x-signed': 'SIGNED_PRIVATE' }); };
  const client = new HongguoDownloadClient(config, { request, sign, processMedia: extra.processMedia ?? fixtureProcessMedia });
  t.after(() => client.dispose());
  return { root, legacy, config, client, request, sign, batches, urls, signs, setMedia(value) { media = value; } };
}

test('default original source fails explicitly without silently selecting preview or manifest', async () => {
  const client = new HongguoDownloadClient();
  const result = await client.info({ seriesIds: ['123'] });
  assert.equal(result.ok, false); assert.equal(result.code, 'missing_original_source');
  assert.match(result.message, /config\.json/); await client.dispose();
});

test('source batches accumulate and deduplicate every requested video id', async t => {
  const f = await fixture(t);
  const source = new SourceCatalog(f.client.config, { request: f.request, sign: f.sign });
  const vids = Array.from({ length: 12 }, (_, i) => `vid${i}`);
  const result = await source.videoUrls([...vids, ...vids.slice(0, 3)], emptySignal());
  assert.deepEqual([...result.keys()], vids);
  assert.deepEqual(f.batches.map(batch => batch.length), [5, 5, 2]);
});

test('device requests remove case-insensitive session cookie and token headers before signing', async t => {
  const sessionHeaders = { cookie: 'SESSION_PRIVATE', Cookie: 'SESSION_UPPER_PRIVATE', 'x-tt-token': 'TOKEN_PRIVATE',
    'X-TT-Token': 'TOKEN_UPPER_PRIVATE', 'x-normal': 'preserved', 'user-agent': 'SESSION_UA' };
  const f = await fixture(t, { sessionHeaders });
  await f.client.info({ seriesIds: ['101'] });
  for (const headers of [f.signs[0].payload.headers, f.urls[0].options.headers]) {
    assert.equal(Object.keys(headers).some(key => ['cookie', 'x-tt-token'].includes(key.toLowerCase())), false);
    assert.equal(headers['x-normal'], 'preserved');
    assert.equal(headers['user-agent'], 'fixture');
  }
  assert.deepEqual(JSON.parse(await readFile(join(f.legacy, 'config.json'), 'utf8')).session_headers, sessionHeaders);
});

test('normal calls retain the randomly selected session device and keep source series titles', async t => {
  const devices = [0, 1, 2].map(index => ({ query: { device: `fixture-device-${index}` }, user_agent: `fixture-ua-${index}` }));
  const f = await fixture(t, { devices });
  const source = new SourceCatalog(f.client.config, { request: f.request, sign: f.sign, randomIndex: () => 1 });
  for (const id of ['101', '102']) assert.equal((await source.episodes(id, emptySignal())).title, `标题${id}`);
  assert.deepEqual(f.urls.map(item => new URL(item.value).searchParams.get('device')), ['fixture-device-1', 'fixture-device-1']);
  assert.deepEqual(f.signs.map(item => item.payload.headers['user-agent']), ['fixture-ua-1', 'fixture-ua-1']);
});

test('risk replies rotate the pinned device and retry while authorization and gone errors retain it', async t => {
  const devices = [0, 1, 2].map(index => ({ query: { device: `fixture-device-${index}` }, user_agent: `fixture-ua-${index}` }));
  const f = await fixture(t, { devices });
  for (const risk of [{ code: 100001 }, { code: 7999 }, { code: 0, BaseResp: { StatusMessage: 'Please verify' } }]) {
    const requested = [];
    const source = new SourceCatalog(resolveConfig({ ...f.config, retries: 1 }), { randomIndex: () => 2, sign: f.sign,
      request: async url => { requested.push(new URL(url).searchParams.get('device')); return reply(requested.length === 1 ? risk : { code: 0 }); } });
    assert.deepEqual(await source.api('/test', {}, emptySignal()), { code: 0 });
    assert.deepEqual(requested, ['fixture-device-2', 'fixture-device-0']);
  }
  for (const code of [101001, 401, 403, 1001, 8]) {
    const requested = [];
    const source = new SourceCatalog(resolveConfig({ ...f.config, retries: 2 }), { randomIndex: () => 1, sign: f.sign,
      request: async url => { requested.push(new URL(url).searchParams.get('device')); return reply({ code }); } });
    await assert.rejects(source.api('/test', {}, emptySignal()), error => error.code === 'platform_error');
    assert.deepEqual(requested, ['fixture-device-1']);
    assert.equal(source.deviceIndex, 1);
  }
});

test('persistent risk replies exhaust the configured retry budget without returning source messages', async t => {
  const devices = [0, 1].map(index => ({ query: { device: `fixture-device-${index}` }, user_agent: `fixture-ua-${index}` }));
  const f = await fixture(t, { devices });
  const requested = [];
  const source = new SourceCatalog(resolveConfig({ ...f.config, retries: 1 }), { randomIndex: () => 0, sign: f.sign,
    request: async url => { requested.push(new URL(url).searchParams.get('device')); return reply({ code: 100001, message: 'SOURCE_PRIVATE' }); } });
  await assert.rejects(source.api('/test', {}, emptySignal()), error => error.code === 'platform_error' && !error.message.includes('SOURCE_PRIVATE'));
  assert.deepEqual(requested, ['fixture-device-0', 'fixture-device-1']);
});

test('selected source quality retains private encryption data and ciphertext length', async t => {
  const f = await fixture(t);
  const tracks = {
    encrypted: [
      { main_url: 'https://v1.qznovelvod.com/plain-small', video_meta: { size: 100 } },
      { main_url: 'https://v1.qznovelvod.com/encrypted-best', video_meta: { size: 200 }, encrypt_info: { encrypt: true, spade_a: 'SPADE_PRIVATE' } },
    ],
    plain: [{ main_url: 'https://v1.qznovelvod.com/plain', video_meta: { size: 300 }, encrypt_info: { encrypt: false, spade_a: 'UNUSED_PRIVATE' } }],
  };
  const source = new SourceCatalog(f.client.config, { sign: f.sign, request: async () => reply({ data: Object.fromEntries(
    Object.entries(tracks).map(([vid, video_list]) => [vid, { video_model: JSON.stringify({ video_list }) }]),
  ) }) });
  const result = await source.videoUrls(['encrypted', 'plain'], emptySignal());
  assert.deepEqual(result.get('encrypted'), { url: 'https://v1.qznovelvod.com/encrypted-best', expectedBytes: 200, sha256: null, encryption: { spade: 'SPADE_PRIVATE' } });
  assert.deepEqual(result.get('plain'), { url: 'https://v1.qznovelvod.com/plain', expectedBytes: 300, sha256: null, encryption: null });
});

test('encrypted tracks require bounded nonempty private decryption information', async t => {
  const f = await fixture(t);
  for (const spade_a of [undefined, null, 42, '', ' ', 'x'.repeat(16 * 1024 + 1), '界'.repeat(6000)]) {
    const source = new SourceCatalog(f.client.config, { sign: f.sign, request: async () => reply({ data: { vid: { video_model: JSON.stringify({
      video_list: [{ main_url: 'https://v1.qznovelvod.com/video?token=URL_PRIVATE', video_meta: { size: 200 }, encrypt_info: { encrypt: true, spade_a } }],
    }) } } }) });
    await assert.rejects(source.videoUrls(['vid'], emptySignal()), error => error.code === 'encrypted_media'
      && error.message === '原源加密媒体缺少有效的本地解密信息');
  }
});

test('two series with seven episodes each publish all files with correct final paths and hashes', async t => {
  const f = await fixture(t);
  const result = await f.client.download({ seriesIds: ['101', '102'] });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.complete, true);
  assert.deepEqual(result.items.map(item => item.downloadedEpisodeCount), [7, 7]);
  assert.deepEqual(f.batches.map(batch => batch.length), [5, 2, 5, 2]);
  for (const item of result.items) {
    assert.deepEqual(item.episodes.map(episode => episode.index), [1, 2, 3, 4, 5, 6, 7]);
    for (const episode of item.episodes) { assert.equal(episode.sha256, sha256); assert.deepEqual(await readFile(episode.path), mp4); }
  }
  assert.equal(result.fullDecodeChecked, true);
  const stored = await readFile(join(result.path, 'download-manifest.json'), 'utf8');
  assert.equal(JSON.parse(stored).path, result.path);
  assert.doesNotMatch(stored, /MEDIA_SECRET|SESSION_PRIVATE|SIGNED_PRIVATE|PRIVATE_DEVICE/);
  assert.equal((await readdir(join(f.root, 'downloads'))).length, 1);
});

test('CDN legacy transient failures refresh only the failed video before publishing a complete series', async t => {
  for (const failure of ['403', 'unsafe_redirect', 'network', 'incomplete_media']) {
    const f = await fixture(t, { count: 3, config: { retries: 1, concurrency: 1 },
      mediaUrl: (vid, version) => `https://v1.qznovelvod.com/${vid}?model_version=${version}` });
    const attempts = new Map();
    f.setMedia(value => {
      const url = new URL(value), count = (attempts.get(url.pathname) ?? 0) + 1;
      attempts.set(url.pathname, count);
      if (url.pathname === '/101v2' && count === 1) {
        if (failure === '403') return reply(Buffer.alloc(0), 403);
        if (failure === 'incomplete_media') return reply(mp4.subarray(0, 12), 200, { 'content-length': String(mp4.length) });
        throw new DownloadError(failure, 'Synthetic transient media failure');
      }
      return reply(mp4, 200, { 'content-length': String(mp4.length) });
    });
    const result = await f.client.download({ seriesIds: ['101'] });
    assert.equal(result.ok, true, `${failure}: ${JSON.stringify(result)}`);
    assert.equal(result.complete, true);
    assert.deepEqual(f.batches, [['101v1', '101v2', '101v3'], ['101v2']]);
    assert.deepEqual([...attempts.values()], [1, 2, 1]);
    assert.deepEqual(f.urls.filter(item => item.kind === 'media' && new URL(item.value).pathname === '/101v2')
      .map(item => new URL(item.value).searchParams.get('model_version')), ['1', '2']);
    for (const episode of result.items[0].episodes) {
      assert.equal(episode.sha256, sha256);
      assert.deepEqual(await readFile(episode.path), mp4);
    }
    assert.equal((await readdir(join(f.root, 'downloads'))).length, 1);
  }
});

test('CDN legacy refresh exhaustion respects the retry budget and removes earlier files', async t => {
  for (const failure of ['403', 'unsafe_redirect', 'network', 'incomplete_media']) {
    const f = await fixture(t, { count: 2, config: { retries: 2, concurrency: 1 },
      mediaUrl: (vid, version) => `https://v1.qznovelvod.com/${vid}?model_version=${version}` });
    let attempts = 0;
    f.setMedia(value => {
      if (new URL(value).pathname === '/101v1') return reply(mp4, 200, { 'content-length': String(mp4.length) });
      attempts++;
      if (failure === '403') return reply(Buffer.alloc(0), 403);
      if (failure === 'incomplete_media') return reply(mp4.subarray(0, 12), 200, { 'content-length': String(mp4.length) });
      throw new DownloadError(failure, 'Synthetic transient media failure');
    });
    const result = await f.client.download({ seriesIds: ['101'] });
    assert.equal(result.ok, false);
    assert.equal(result.complete, false);
    assert.equal(result.code, failure === '403' ? 'http_error' : failure);
    assert.equal(attempts, 3);
    assert.deepEqual(f.batches, [['101v1', '101v2'], ['101v2'], ['101v2']]);
    assert.deepEqual(await readdir(join(f.root, 'downloads')), []);
  }
});

test('CDN nonlegacy HTTP 403 does not retry or call the original source', async t => {
  for (const sourceMode of ['manifest', 'public']) {
    const f = await fixture(t, { count: 1 });
    const catalogPath = join(f.root, 'retry-catalog.json');
    await writeFile(catalogPath, JSON.stringify({ series: [{ series_id: '101', title: 'Synthetic series', episodes: [
      { index: 1, url: 'https://v1.qznovelvod.com/101v1', sha256 },
    ] }] }));
    const player = { loaderData: { 'player_(series_id)/page': { isSuccess: true, series_id: '101', vid: 'v1', seriesDetail: {
      series_id: '101', series_name: 'Synthetic series', episode_cnt: 1, accessible_episode_cnt: 1, vid_list: ['v1'],
    }, video_player_info: { main_url: 'https://v1-hgweb.qznovelvod.com/1', duration: 10 } } } };
    let mediaRequests = 0, sourceRequests = 0;
    const client = new HongguoDownloadClient({ sourceMode, catalogPath, outputRoot: f.root, retries: 2, retryDelayMs: 0 }, {
      source: {
        episodes() { sourceRequests++; throw new Error('Unexpected original catalog call'); },
        videoUrls() { sourceRequests++; throw new Error('Unexpected original media refresh'); },
      },
      request: async (_url, kind) => {
        if (kind === 'page') return reply(Buffer.from(`window._ROUTER_DATA = ${JSON.stringify(player)};`));
        mediaRequests++; return reply(Buffer.alloc(0), 403);
      }, processMedia: fixtureProcessMedia,
    });
    t.after(() => client.dispose());
    const result = await client.download({ seriesIds: ['101'] });
    assert.equal(result.ok, false); assert.equal(result.code, 'http_error');
    assert.equal(mediaRequests, 1); assert.equal(sourceRequests, 0);
    assert.deepEqual(await readdir(join(f.root, 'downloads')), []);
  }
});

test('CDN authorization, decode, unsafe URL and unknown failures never refresh the source', async t => {
  for (const failure of ['401', 'decode_failed', 'unsafe_url', 'unexpected_failure']) {
    const f = await fixture(t, { count: 1, config: { retries: 2 }, processMedia: failure === 'decode_failed'
      ? async () => { throw new DownloadError('decode_failed', 'Synthetic decode failure'); } : fixtureProcessMedia });
    f.setMedia(() => {
      if (failure === '401') return reply(Buffer.alloc(0), 401);
      if (failure === 'unsafe_url' || failure === 'unexpected_failure') throw new DownloadError(failure, 'Synthetic permanent media failure');
      return reply(mp4, 200, { 'content-length': String(mp4.length) });
    });
    const result = await f.client.download({ seriesIds: ['101'] });
    assert.equal(result.ok, false);
    assert.equal(result.code, failure === '401' ? 'http_error' : failure);
    assert.deepEqual(f.batches, [['101v1']]);
    assert.equal(f.urls.filter(item => item.kind === 'media').length, 1);
    assert.deepEqual(await readdir(join(f.root, 'downloads')), []);
  }
});

test('CDN legacy media uses configured user agent without session headers or signer fields', async t => {
  const sessionHeaders = { Referer: 'https://session.example/PRIVATE_REFERER', Cookie: 'SESSION_PRIVATE',
    'X-TT-Token': 'TOKEN_PRIVATE', 'user-agent': 'SESSION_UA_PRIVATE', 'x-custom': 'CUSTOM_PRIVATE' };
  const f = await fixture(t, { count: 1, sessionHeaders, config: { mediaUserAgent: 'Synthetic Android media UA' } });
  const result = await f.client.download({ seriesIds: ['101'] });
  assert.equal(result.ok, true);
  assert.equal(f.signs[0].payload.headers.Referer, sessionHeaders.Referer);
  const media = f.urls.find(item => item.kind === 'media');
  assert.deepEqual(media.options.headers, { 'user-agent': 'Synthetic Android media UA' });
  assert.doesNotMatch(JSON.stringify(media.options.headers), /PRIVATE|SIGNED_PRIVATE|SESSION_UA/);
});

test('CDN public media retains the official referer alongside the configured user agent', async t => {
  const f = await fixture(t, { count: 1 });
  const player = { loaderData: { 'player_(series_id)/page': { isSuccess: true, series_id: '101', vid: 'v1', seriesDetail: {
    series_id: '101', series_name: 'Synthetic series', episode_cnt: 1, accessible_episode_cnt: 1, vid_list: ['v1'],
  }, video_player_info: { main_url: 'https://v1-hgweb.qznovelvod.com/1', duration: 10 } } } };
  const mediaHeaders = [];
  const client = new HongguoDownloadClient({ sourceMode: 'public', outputRoot: f.root, retries: 2, retryDelayMs: 0,
    mediaUserAgent: 'Synthetic public media UA' }, { request: async (_url, kind, _signal, options) => {
    if (kind === 'page') return reply(Buffer.from(`window._ROUTER_DATA = ${JSON.stringify(player)};`));
    mediaHeaders.push(options.headers); return reply(mp4, 200, { 'content-length': String(mp4.length) });
  }, processMedia: fixtureProcessMedia });
  t.after(() => client.dispose());
  const result = await client.download({ seriesIds: ['101'] });
  assert.equal(result.ok, true); assert.equal(result.complete, true);
  assert.deepEqual(mediaHeaders, [{ 'user-agent': 'Synthetic public media UA', referer: 'https://hongguoduanju.com/' }]);
});

test('encrypted multi-series files preserve source hashes and publish only processed MP4 hashes', async t => {
  const ciphertext = Buffer.from('fixture encrypted source bytes');
  const sourceSha256 = createHash('sha256').update(ciphertext).digest('hex');
  let processed = 0;
  const f = await fixture(t, { count: 2, media: ciphertext, expectedBytes: ciphertext.length,
    encryptInfo: { encrypt: true, spade_a: 'SPADE_PRIVATE' },
    processMedia: async (media, { inputPath, outputPath }) => {
      assert.deepEqual(await readFile(inputPath), ciphertext);
      assert.deepEqual(media.encryption, { spade: 'SPADE_PRIVATE' });
      assert.equal(media.expectedBytes, ciphertext.length);
      await writeFile(outputPath, mp4, { flag: 'wx' });
      processed++;
      return { processedPath: outputPath, durationSeconds: 10, fullDecodeChecked: true, validationLevel: 'ffprobe-full-decode-sha256' };
    } });
  const result = await f.client.download({ seriesIds: ['101', '102'] });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.complete, true); assert.equal(processed, 4);
  for (const item of result.items) {
    for (const episode of item.episodes) {
      assert.equal(episode.sha256, sha256); assert.equal(episode.bytes, mp4.length);
      assert.equal(episode.sourceSha256, sourceSha256); assert.equal(episode.sourceBytes, ciphertext.length);
      assert.equal(episode.encryptedSource, true); assert.equal(episode.fullDecodeChecked, true);
      assert.deepEqual(await readFile(episode.path), mp4);
    }
  }
  const stored = await readFile(join(result.path, 'download-manifest.json'), 'utf8');
  assert.doesNotMatch(JSON.stringify(result) + stored, /SPADE_PRIVATE|MEDIA_SECRET|SIGNED_PRIVATE|PRIVATE_DEVICE/);
});

test('encrypted source length failures stop before processing or publishing files', async t => {
  const ciphertext = Buffer.from('ciphertext'); let processed = false;
  const f = await fixture(t, { count: 1, media: ciphertext, expectedBytes: ciphertext.length + 1,
    encryptInfo: { encrypt: true, spade_a: 'SPADE_PRIVATE' }, processMedia: async () => { processed = true; throw new Error('Unexpected processing'); } });
  const result = await f.client.download({ seriesIds: ['101'] });
  assert.equal(result.code, 'incomplete_media'); assert.equal(processed, false);
  assert.deepEqual(await readdir(join(f.root, 'downloads')), []);
});

test('a processing failure removes earlier series and partial decoded output', async t => {
  const ciphertext = Buffer.from('ciphertext'); let processed = 0;
  const f = await fixture(t, { count: 1, media: ciphertext, expectedBytes: ciphertext.length,
    encryptInfo: { encrypt: true, spade_a: 'SPADE_PRIVATE' },
    processMedia: async (_media, { outputPath }) => {
      await writeFile(outputPath, mp4, { flag: 'wx' });
      if (++processed === 2) throw new Error('PROCESSOR_PRIVATE');
      return { processedPath: outputPath, durationSeconds: 10, fullDecodeChecked: true, validationLevel: 'ffprobe-full-decode-sha256' };
    } });
  const result = await f.client.download({ seriesIds: ['101', '102'] });
  assert.equal(result.ok, false); assert.equal(result.code, 'operation_failed'); assert.equal(processed, 2);
  assert.doesNotMatch(JSON.stringify(result), /SPADE_PRIVATE|PROCESSOR_PRIVATE/);
  assert.deepEqual(await readdir(join(f.root, 'downloads')), []);
});

test('processor verdicts require complete decoding and valid processed MP4 containers', async t => {
  for (const invalid of ['verdict', 'container']) {
    const ciphertext = Buffer.from('ciphertext');
    const f = await fixture(t, { count: 1, media: ciphertext, expectedBytes: ciphertext.length,
      encryptInfo: { encrypt: true, spade_a: 'SPADE_PRIVATE' },
      processMedia: async (_media, { outputPath }) => {
        await writeFile(outputPath, invalid === 'container' ? Buffer.from('not an MP4') : mp4, { flag: 'wx' });
        return { processedPath: outputPath, durationSeconds: 10, fullDecodeChecked: invalid !== 'verdict', validationLevel: 'ffprobe-full-decode-sha256' };
      } });
    assert.equal((await f.client.download({ seriesIds: ['101'] })).code, 'invalid_media');
    assert.deepEqual(await readdir(join(f.root, 'downloads')), []);
  }
});

test('cancellation and disposal await processing termination and remove decoded staging files', async t => {
  for (const mode of ['cancel', 'dispose']) {
    const ciphertext = Buffer.from('ciphertext'), started = deferred(), controller = new AbortController(); let settled = false;
    const f = await fixture(t, { count: 1, media: ciphertext, expectedBytes: ciphertext.length,
      encryptInfo: { encrypt: true, spade_a: 'SPADE_PRIVATE' },
      processMedia: async (_media, { outputPath, signal }) => {
        try {
          await writeFile(outputPath, mp4, { flag: 'wx' }); started.resolve();
          await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
          signal.throwIfAborted(); throw new Error('Unexpected processor completion');
        } finally { settled = true; }
      } });
    const work = f.client.download({ seriesIds: ['101'] }, controller.signal);
    await started.promise;
    if (mode === 'dispose') { await f.client.dispose(); assert.equal(settled, true); }
    else controller.abort();
    const result = await work;
    assert.equal(result.code, 'cancelled'); assert.equal(settled, true);
    assert.deepEqual(await readdir(join(f.root, 'downloads')), []);
  }
});

test('a declared full-series count mismatch refuses all downloads', async t => {
  const f = await fixture(t, { declaredCount: 8 });
  const result = await f.client.download({ seriesIds: ['101'] });
  assert.equal(result.code, 'incomplete_catalog'); assert.equal(result.complete, false);
  assert.equal(f.urls.filter(item => item.kind === 'media').length, 0);
});

test('a missing declared total cannot be presented as a verified full catalog', async t => {
  const f = await fixture(t, { declaredCount: 'unknown' });
  const result = await f.client.info({ seriesIds: ['101'] });
  assert.equal(result.code, 'unverified_episode_count'); assert.equal(result.ok, false);
});

test('default original-source downloads include every episode of two 209-episode series', async t => {
  const f = await fixture(t, { count: 209 });
  const result = await f.client.download({ seriesIds: ['101', '102'] });
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map(item => [item.episodeCount, item.downloadedEpisodeCount]), [[209, 209], [209, 209]]);
  assert.equal(f.urls.filter(item => item.kind === 'media').length, 418);
});

test('the full catalog and requested last episode follow real counts beyond former caps', async t => {
  const f = await fixture(t, { count: 10001 });
  const info = await f.client.info({ seriesIds: ['101'] });
  assert.equal(info.ok, true);
  assert.equal(info.items[0].episodeCount, 10001);
  assert.equal(info.items[0].completeCatalog, true);
  const result = await f.client.download({ seriesIds: ['101'], episodes: [10001] });
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(result.items[0].episodes[0].index, 10001);
  assert.equal(f.urls.filter(item => item.kind === 'media').length, 1);
  assert.throws(() => resolveConfig({ maxEpisodes: 200 }), /未知红果插件配置字段/);
});

test('an invalid episode rolls back every file already downloaded for the whole batch', async t => {
  const f = await fixture(t);
  f.setMedia(value => value.includes('102v1') ? reply(Buffer.from('<html>PRIVATE_TOKEN</html>'), 200, { 'content-type': 'text/html' })
    : reply(mp4, 200, { 'content-length': String(mp4.length) }));
  const result = await f.client.download({ seriesIds: ['101', '102'] });
  assert.equal(result.ok, false); assert.equal(result.code, 'invalid_media');
  assert.deepEqual(await readdir(join(f.root, 'downloads')), []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|MEDIA_SECRET/);
});

test('partial explicit episode selection never reports full-series completion', async t => {
  const f = await fixture(t);
  const result = await f.client.download({ seriesIds: ['101'], episodes: [7, 1] });
  assert.equal(result.ok, true); assert.equal(result.complete, false);
  assert.deepEqual(result.items[0].episodes.map(episode => episode.index), [1, 7]);
});

test('caller cancellation waits for stream release and removes the batch staging directory', async t => {
  const f = await fixture(t, { count: 1 });
  const started = deferred(), controller = new AbortController();
  f.setMedia((_url, signal) => {
    const stream = Readable.from((async function* () {
      yield mp4.subarray(0, 12); started.resolve();
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      signal.throwIfAborted();
    })());
    return Object.assign(stream, { statusCode: 200, headers: { 'content-length': String(mp4.length) } });
  });
  const work = f.client.download({ seriesIds: ['101'] }, controller.signal);
  await started.promise; controller.abort();
  const result = await work;
  assert.equal(result.code, 'cancelled'); assert.deepEqual(await readdir(join(f.root, 'downloads')), []);
});

test('dispose aborts active downloads and waits for their cleanup', async t => {
  const f = await fixture(t, { count: 1 });
  const started = deferred();
  f.setMedia((_url, signal) => Object.assign(Readable.from((async function* () {
    yield mp4.subarray(0, 12); started.resolve();
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    signal.throwIfAborted();
  })()), { statusCode: 200, headers: {} }));
  const work = f.client.download({ seriesIds: ['101'] });
  await started.promise; await f.client.dispose();
  assert.equal((await work).code, 'cancelled'); assert.deepEqual(await readdir(join(f.root, 'downloads')), []);
});

test('output arguments cannot escape the session workspace or follow a child directory link', async t => {
  const f = await fixture(t, { count: 1 });
  const outside = await mkdtemp(join(tmpdir(), 'muse-hongguo-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  assert.equal((await f.client.download({ seriesIds: ['101'], outputDir: outside })).code, 'unsafe_path');
  await symlink(outside, join(f.root, 'linked'), 'dir');
  assert.equal((await f.client.download({ seriesIds: ['101'], outputDir: 'linked' })).code, 'unsafe_path');
  assert.deepEqual(await readdir(outside), []);
});

test('manifest source validates every hash and declares only its own coverage', async t => {
  const f = await fixture(t);
  const catalogPath = join(f.root, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify({ series: [{ series_id: 's1', title: '授权目录', episodes: [{ index: 1, url: 'https://v1.qznovelvod.com/a?token=MANIFEST_SECRET', sha256 }] }] }));
  const client = new HongguoDownloadClient({ sourceMode: 'manifest', catalogPath, outputRoot: f.root }, { request: f.request, processMedia: fixtureProcessMedia });
  t.after(() => client.dispose());
  const result = await client.download({ seriesIds: ['s1'] });
  assert.equal(result.ok, true); assert.equal(result.complete, true); assert.match(result.note, /不代表红果平台全剧验收/);
  await writeFile(catalogPath, JSON.stringify({ series: [{ series_id: 's1', title: '目录', episodes: [{ index: 1, url: 'https://v1.qznovelvod.com/a', sha256: '0'.repeat(64) }] }] }));
  const failed = await client.download({ seriesIds: ['s1'] });
  assert.equal(failed.code, 'checksum_mismatch'); assert.doesNotMatch(JSON.stringify(failed), /MANIFEST_SECRET/);
});

test('public preview is never substituted for a default full-series request', async t => {
  const f = await fixture(t);
  const player = { loaderData: { 'player_(series_id)/page': { isSuccess: true, series_id: '123', vid: 'v1', seriesDetail: {
    series_id: '123', series_name: '公开剧', episode_cnt: 7, accessible_episode_cnt: 1, vid_list: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'],
  }, video_player_info: { main_url: 'https://v1-hgweb.qznovelvod.com/1', duration: 10 } } } };
  const client = new HongguoDownloadClient({ sourceMode: 'public', outputRoot: f.root }, { request: async () => reply(Buffer.from(`window._ROUTER_DATA = ${JSON.stringify(player)};`)) });
  t.after(() => client.dispose());
  const info = await client.info({ seriesIds: ['123'] }); assert.equal(info.items[0].fullSeriesAvailable, false);
  assert.equal((await client.download({ seriesIds: ['123'] })).code, 'public_preview_only');
  const accessibleSecond = structuredClone(player);
  accessibleSecond.loaderData['player_(series_id)/page'].seriesDetail.accessible_episode_cnt = 2;
  assert.throws(() => parsePlayer(`window._ROUTER_DATA = ${JSON.stringify(accessibleSecond)};`, '123', 2), /与请求不一致|没有/);
});

test('host tools obtain the workspace from the initiating session and declare canonical output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-hongguo-tool-')); t.after(() => rm(root, { recursive: true, force: true }));
  const tools = [], cleanup = [];
  apply({ tools: { register(value) { tools.push(value); return () => {}; } }, agents: { requireInitiator() { return { session: { header: { cwd: root } } }; } },
    subprocess: { spawn() { throw new Error('Unexpected subprocess before source configuration'); } }, effect(factory) { cleanup.push(factory()); } });
  t.after(() => Promise.all(cleanup.map(fn => fn())));
  assert.deepEqual(tools.map(item => item.name), ['hongguo_download_info', 'hongguo_download']);
  assert.equal(tools[1].presentCall().kind, 'write');
  const result = await tools[1].execute({ seriesIds: ['123'] }, { signal: emptySignal() });
  assert.equal(result.code, 'missing_original_source');
  assert.equal(tools[1].output.render({}, result)[0].type, 'text');
});

test('config and URL validation reject unsafe and unknown settings', () => {
  assert.throws(() => resolveConfig({ signToken: 'SECRET' }), /未知/);
  assert.throws(() => resolveConfig({ signTokenEnv: 'bad-name' }), /环境变量/);
  assert.throws(() => resolveConfig({ signServer: 'http://10.0.0.1:8123' }), /127\.0\.0\.1/);
  for (const url of ['http://v1.qznovelvod.com/a', 'https://user:SECRET@v1.qznovelvod.com/a', 'https://unconfigured.example/a']) assert.throws(() => checkedUrl(url, 'media', ['*.qznovelvod.com']), /拒绝/);
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:8.8.8.8', '2001:db8::1']) assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress('8.8.8.8'), true);
});

test('media port defaults allow official CDN hosts on 443 and 9305 while rejecting other ports', () => {
  const config = resolveConfig();
  assert.deepEqual(config.mediaPorts, [443, 9305]);
  for (const hostname of ['v1.qznovelvod.com', 'v1.douyinvod.com', 'rt2016n-41.free-lbv13.idouyinvod.com', 'media.pkoplink.com', 'media.bdcgslb.com', 'media.vegslb.com', 'bvqhvgghkihvgu.jspcdn.cn', '3026312747.qrstuvwxyzab.com']) {
    for (const suffix of ['', ':443', ':9305']) {
      const value = `https://${hostname}${suffix}/fixture.mp4`;
      assert.equal(checkedUrl(value, 'media', config.mediaHosts, config.mediaPorts).hostname, hostname);
    }
    assert.throws(() => checkedUrl(`https://${hostname}:9306/fixture.mp4`, 'media', config.mediaHosts, config.mediaPorts),
      error => error.code === 'unsafe_url');
  }
  for (const value of ['http://media.jspcdn.cn/fixture.mp4', 'https://media.jspcdn.cn.evil.example/fixture.mp4', 'https://user:secret@media.jspcdn.cn/fixture.mp4',
    'http://media.idouyinvod.com/fixture.mp4', 'https://media.idouyinvod.com.evil.example/fixture.mp4', 'https://user:secret@media.idouyinvod.com/fixture.mp4']) {
    assert.throws(() => checkedUrl(value, 'media', config.mediaHosts, config.mediaPorts), error => error.code === 'unsafe_url');
  }
});

test('media port config validates bounded unique integer ports and retains explicit host choices', () => {
  const mediaPorts = [1, 443, 8443, 65535], mediaHosts = ['cdn.example.org'];
  const config = resolveConfig({ mediaPorts, mediaHosts });
  assert.deepEqual(config.mediaPorts, mediaPorts);
  assert.deepEqual(config.mediaHosts, mediaHosts);
  for (const port of mediaPorts) {
    assert.equal(checkedUrl(`https://cdn.example.org:${port}/fixture.mp4`, 'media', config.mediaHosts, config.mediaPorts).hostname,
      'cdn.example.org');
  }
  mediaPorts.push(9305); mediaHosts.push('other.example.org');
  assert.deepEqual(config.mediaPorts, [1, 443, 8443, 65535]);
  assert.deepEqual(config.mediaHosts, ['cdn.example.org']);
  const fortyPorts = Array.from({ length: 40 }, (_, index) => index + 1);
  assert.deepEqual(resolveConfig({ mediaPorts: fortyPorts }).mediaPorts, fortyPorts);
  for (const value of [null, 443, '443', [], [0], [-1], [65536], [443.5], ['443'], [NaN], [Infinity], [443, 443], [...fortyPorts, 41]]) {
    assert.throws(() => resolveConfig({ mediaPorts: value }), /mediaPorts/);
  }
});

test('media port allowances never admit HTTP, user information or unconfigured hosts and ports', () => {
  const config = resolveConfig({ mediaHosts: ['*.pkoplink.com'], mediaPorts: [8443] });
  assert.equal(checkedUrl('https://media.pkoplink.com:8443/fixture.mp4', 'media', config.mediaHosts, config.mediaPorts).port, '8443');
  for (const value of ['http://media.pkoplink.com:8443/fixture.mp4', 'https://user:fixture@media.pkoplink.com:8443/fixture.mp4',
    'https://pkoplink.com:8443/fixture.mp4', 'https://media.pkoplink.com.other.example:8443/fixture.mp4',
    'https://unconfigured.example:8443/fixture.mp4', 'https://media.pkoplink.com:9305/fixture.mp4',
    'https://media.pkoplink.com/fixture.mp4', 'https://media.pkoplink.com:65536/fixture.mp4']) {
    assert.throws(() => checkedUrl(value, 'media', config.mediaHosts, config.mediaPorts), error => error.code === 'unsafe_url');
  }
});

test('media port extensions leave page and API requests restricted to HTTPS port 443', () => {
  const config = resolveConfig({ mediaPorts: [9305, 8443] });
  for (const [kind, hostname] of [['page', 'hongguoduanju.com'], ['api', 'api.example.org']]) {
    for (const suffix of ['', ':443']) {
      assert.equal(checkedUrl(`https://${hostname}${suffix}/fixture`, kind, [hostname], config.mediaPorts).hostname, hostname);
    }
    for (const port of config.mediaPorts) {
      assert.throws(() => checkedUrl(`https://${hostname}:${port}/fixture`, kind, [hostname], config.mediaPorts),
        error => error.code === 'unsafe_url');
    }
    assert.throws(() => checkedUrl(`http://${hostname}:443/fixture`, kind, [hostname], config.mediaPorts),
      error => error.code === 'unsafe_url');
  }
});
