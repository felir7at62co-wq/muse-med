/** Request quality stays isolated across concurrent sources, checkpoints and measured receipts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { HongguoDownloadClient } from '../src/client.js';
import { JackotomSource } from '../src/jackotom.js';

const box = (type, payload = Buffer.alloc(0)) => {
  const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type, 4);
  return Buffer.concat([header, payload]);
};
const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', box('trak', box('mdia'))), box('mdat', Buffer.from('quality fixture'))]);

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-hongguo-quality-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = join(root, 'catalog.json');
  if (extra.manifest) await writeFile(catalogPath, JSON.stringify({ series: [{ series_id: 'manifest', title: 'source',
    episodes: [{ index: 1, url: 'https://media.jspcdn.cn/manifest' }] }] }));
  const play = [], requests = [], factories = [];
  const engine = {
    async fetchEpisodeList(id) {
      return { series_id: id, series_title: `Series ${id}`, total: 1, episodes: [{ vid: `${id}1`, vid_index: 1, title: 'one' }] };
    },
    async fetchPlayUrlSingle(vid, id, options) {
      play.push({ vid, id, quality: options.quality });
      await extra.beforePlay?.(options);
      const edge = extra.sourceEdge ?? (options.quality === 'auto' ? 480 : options.quality === '720p' ? 720 : 1080);
      return { vid, url: `https://media.jspcdn.cn/${vid}/${options.quality}`, width: edge, height: edge * 2, duration: 10, codec: 'h264' };
    },
  };
  const processMedia = async (media, { inputPath }) => ({ processedPath: inputPath, durationSeconds: 10,
    ...(extra.noMeasurements ? {} : { width: extra.dimensions?.width ?? extra.actualEdge ?? media.expectedWidth,
      height: extra.dimensions?.height ?? (extra.actualEdge ?? media.expectedWidth) * 2, videoCodec: 'h264' }),
    fullDecodeChecked: true, validationLevel: 'ffprobe-full-decode-sha256' });
  const request = async (url) => {
    requests.push(url);
    return Object.assign(Readable.from([mp4]), { statusCode: 200, headers: { 'content-length': String(mp4.length) } });
  };
  const dependencies = { engine, request, processMedia,
    ...(extra.sourceFactory ? { sourceFactory: config => { factories.push(config); return new JackotomSource(config, engine); } } : {}) };
  const client = new HongguoDownloadClient({ outputRoot: root, quality: extra.defaultQuality ?? '1080p', retries: 0,
    ...(extra.manifest ? { catalogPath } : {}) }, dependencies);
  t.after(() => client.dispose());
  return { root, client, play, requests, factories, dependencies };
}

test('one request overrides its deployment quality and reports actual higher-resolution dimensions', async t => {
  const f = await fixture(t, { defaultQuality: '720p', sourceEdge: 2160 });
  const result = await f.client.download({ seriesIds: ['101'], quality: '1080p' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.requestedQuality, '1080p');
  assert.deepEqual(f.play.map(item => item.quality), ['1080p']);
  assert.equal(f.client.config.quality, '720p');
  assert.equal(f.client.source.config.quality, '720p');
  const episode = result.items[0].episodes[0];
  assert.deepEqual([episode.width, episode.height, episode.quality, episode.videoCodec], [2160, 4320, '2160p', 'h264']);
  assert.equal(JSON.parse(await readFile(join(result.path, 'download-manifest.json'), 'utf8')).requestedQuality, '1080p');
});

test('concurrent 720p and 1080p requests keep independent sources and recovery directories', async t => {
  let entered = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforePlay: async () => { if (++entered === 2) release(); await both; } });
  const results = await Promise.all(['720p', '1080p'].map(quality => f.client.download({ seriesIds: ['101'], quality })));
  assert.ok(results.every(item => item.ok), JSON.stringify(results));
  assert.notEqual(results[0].path, results[1].path);
  assert.deepEqual(results.map(item => item.requestedQuality), ['720p', '1080p']);
  assert.deepEqual(results.map(item => item.items[0].episodes[0].quality), ['720p', '1080p']);
  assert.deepEqual(f.play.map(item => item.quality).sort(), ['1080p', '720p']);
});

test('auto delegates compatibility selection and an omitted legacy quality uses the configured default', async t => {
  const f = await fixture(t, { defaultQuality: '720p' });
  const automatic = await f.client.download({ seriesIds: ['101'], quality: 'auto' });
  const configured = await f.client.download({ seriesIds: ['102'] });
  assert.equal(automatic.ok, true); assert.equal(configured.ok, true);
  assert.equal(automatic.requestedQuality, 'auto');
  assert.equal(automatic.items[0].episodes[0].quality, '480p');
  assert.deepEqual(f.play.map(item => item.quality), ['auto', '720p']);
});

test('unavailable requested quality stops before transfer and never silently downgrades', async t => {
  const f = await fixture(t, { sourceEdge: 720 });
  const result = await f.client.download({ seriesIds: ['101'], quality: '1080p' });
  assert.equal(result.code, 'quality_unavailable');
  assert.equal(result.requestedQuality, '1080p');
  assert.equal(result.resume.quality, '1080p');
  assert.equal(f.requests.length, 0);
});

test('different-quality historical receipts cannot satisfy a higher-quality request', async t => {
  const f = await fixture(t);
  const low = await f.client.download({ seriesIds: ['101'], quality: '720p', outputDir: 'downloads/nested/prior' });
  const high = await f.client.download({ seriesIds: ['101'], quality: '1080p' });
  assert.equal(low.ok, true); assert.equal(high.ok, true);
  assert.equal(high.reusedEpisodeCount, 0); assert.equal(high.newlyDownloadedEpisodeCount, 1);
  assert.equal(high.items[0].episodes[0].quality, '1080p');
  const calls = f.requests.length;
  const again = await f.client.download({ seriesIds: ['101'], quality: '1080p' });
  assert.equal(again.reusedEpisodeCount, 1); assert.equal(f.requests.length, calls);
});

test('matching old pinned receipts retain unknown dimensions instead of inventing the requested resolution', async t => {
  const f = await fixture(t);
  const first = await f.client.download({ seriesIds: ['101'], outputDir: 'downloads/nested/prior' });
  const receiptPath = join(first.path, 'download-manifest.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  delete receipt.requestedQuality;
  for (const episode of receipt.items[0].episodes) for (const field of ['width', 'height', 'quality', 'videoCodec']) delete episode[field];
  await writeFile(receiptPath, JSON.stringify(receipt));
  const calls = f.requests.length;
  const recovered = await f.client.download({ seriesIds: ['101'] });
  assert.equal(recovered.ok, true); assert.equal(recovered.reusedEpisodeCount, 1);
  assert.equal(f.requests.length, calls);
  assert.deepEqual(['width', 'height', 'quality', 'videoCodec'].map(key => recovered.items[0].episodes[0][key]), [null, null, null, null]);
});

test('custom source factories receive a frozen quality per request without changing the shared source', async t => {
  const f = await fixture(t, { sourceFactory: true });
  await f.client.download({ seriesIds: ['101'], quality: '720p' });
  await f.client.download({ seriesIds: ['102'], quality: 'auto' });
  assert.deepEqual(f.factories.map(config => config.quality), ['1080p', '720p', 'auto']);
  assert.ok(f.factories.every(Object.isFrozen));
  assert.equal(f.client.source.config.quality, '1080p');
});

test('invalid quality values are rejected before source or media requests', async t => {
  const f = await fixture(t);
  for (const quality of ['480p', null, 720]) {
    assert.equal((await f.client.download({ seriesIds: ['101'], quality })).code, 'invalid_arguments');
  }
  assert.equal(f.play.length, 0); assert.equal(f.requests.length, 0);
});

test('manifest source bytes default to auto while explicit quality requires measured dimensions', async t => {
  const f = await fixture(t, { manifest: true, dimensions: { width: 128, height: 72 } });
  const automatic = await f.client.download({ seriesIds: ['manifest'], sourceMode: 'manifest' });
  assert.equal(automatic.ok, true); assert.equal(automatic.requestedQuality, 'auto');
  assert.equal(automatic.items[0].episodes[0].quality, '72p');
  const requested = await f.client.download({ seriesIds: ['manifest'], sourceMode: 'manifest', quality: '720p' });
  assert.equal(requested.code, 'quality_unavailable'); assert.equal(requested.reusedEpisodeCount, 0);
});

test('explicit manifest quality refuses a processor without measured dimensions', async t => {
  const f = await fixture(t, { manifest: true, noMeasurements: true });
  const result = await f.client.download({ seriesIds: ['manifest'], sourceMode: 'manifest', quality: '720p' });
  assert.equal(result.code, 'quality_unverified');
  assert.equal(result.retainedEpisodeCount, 0);
});

test('a resumed request retains its original quality after the deployment default changes', async t => {
  let attempts = 0;
  const f = await fixture(t, { defaultQuality: '720p', beforePlay: async () => { if (++attempts === 1) throw new Error('source failure'); } });
  const first = await f.client.download({ seriesIds: ['101'] });
  assert.equal(first.ok, false); assert.equal(first.resume.quality, '720p');
  const restarted = new HongguoDownloadClient({ outputRoot: f.root, quality: '1080p', retries: 0 }, f.dependencies);
  t.after(() => restarted.dispose());
  const result = await restarted.download(first.resume);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.requestedQuality, '720p'); assert.equal(result.path, first.path);
  assert.equal(result.items[0].episodes[0].quality, '720p');
  assert.equal(restarted.config.quality, '1080p');
  assert.deepEqual(f.play.map(item => item.quality), ['720p', '720p']);
});

test('public auto preserves the previous pinned-source checkpoint id and reuses historical files', async t => {
  const f = await fixture(t);
  f.client.player = async () => ({ info: { title: 'public source', episodeCount: 1, accessibleEpisodeCount: 1,
    publicPlaybackAvailable: true, durationSeconds: 10 }, vids: ['1011'], mediaUrl: 'https://media.jspcdn.cn/public' });
  const first = await f.client.download({ seriesIds: ['101'], sourceMode: 'public', outputDir: 'downloads/nested/prior' });
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.requestedQuality, 'auto');
  const previousRequest = { mode: 'public', seriesIds: ['101'], episodes: null, sourceIdentity: f.client.source.identity };
  const previousId = createHash('sha256').update(JSON.stringify(previousRequest)).digest('hex').slice(0, 32);
  assert.equal(first.path.split(/[/\\]/).at(-1), `hongguo-${previousId}`);
  const calls = f.requests.length;
  const same = await f.client.download({ seriesIds: ['101'], sourceMode: 'public', outputDir: 'downloads/nested/prior' });
  assert.equal(same.path, first.path); assert.equal(same.reusedEpisodeCount, 1); assert.equal(f.requests.length, calls);
  const receiptPath = join(first.path, 'download-manifest.json'), receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  delete receipt.requestedQuality;
  for (const field of ['width', 'height', 'quality', 'videoCodec']) delete receipt.items[0].episodes[0][field];
  await writeFile(receiptPath, JSON.stringify(receipt));
  const recovered = await f.client.download({ seriesIds: ['101'], sourceMode: 'public' });
  assert.equal(recovered.ok, true); assert.equal(recovered.reusedEpisodeCount, 1); assert.equal(f.requests.length, calls);
  assert.equal(recovered.items[0].episodes[0].quality, null);
});

test('a prior public partial checkpoint resumes without source access or invented dimensions', async t => {
  const f = await fixture(t);
  f.client.player = async () => ({ info: { title: 'public partial', episodeCount: 2, accessibleEpisodeCount: 2,
    publicPlaybackAvailable: true, durationSeconds: 10 }, vids: ['1011', '1012'], mediaUrl: 'https://media.jspcdn.cn/public' });
  const args = { seriesIds: ['101'], sourceMode: 'public', episodes: [1] };
  const first = await f.client.download(args);
  assert.equal(first.ok, true); assert.equal(first.complete, false);
  const state = JSON.parse(await readFile(first.checkpoint, 'utf8'));
  const previousRequest = { mode: 'public', seriesIds: ['101'], episodes: [1], sourceIdentity: f.client.source.identity };
  assert.deepEqual(state.request, previousRequest);
  for (const field of ['width', 'height', 'quality', 'videoCodec']) delete state.completed[0].episode[field];
  await writeFile(first.checkpoint, JSON.stringify(state));
  const calls = f.requests.length;
  const restarted = new HongguoDownloadClient(f.client.config, f.dependencies);
  t.after(() => restarted.dispose());
  restarted.player = async () => { throw new Error('a retained partial checkpoint must not re-query public metadata'); };
  const resumed = await restarted.download(args);
  assert.equal(resumed.ok, true, JSON.stringify(resumed)); assert.equal(resumed.complete, false);
  assert.equal(resumed.path, first.path); assert.equal(resumed.reusedEpisodeCount, 1);
  assert.equal(f.requests.length, calls);
  assert.deepEqual(['width', 'height', 'quality', 'videoCodec'].map(key => resumed.items[0].episodes[0][key]), [null, null, null, null]);
});
