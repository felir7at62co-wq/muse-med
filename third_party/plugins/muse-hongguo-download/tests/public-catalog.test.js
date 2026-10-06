/** Public SSR catalogs must describe their actual video list before download planning. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HongguoDownloadClient } from '../src/client.js';
import { parsePlayer } from '../src/parser.js';

const box = (type, bytes = Buffer.alloc(0)) => { const header = Buffer.alloc(8); header.writeUInt32BE(bytes.length + 8); header.write(type, 4); return Buffer.concat([header, bytes]); };
const media = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', box('trak', box('mdia'))), box('mdat', Buffer.from('public fixture'))]);
const reply = body => Object.assign(Readable.from([body]), { statusCode: 200, headers: { 'content-length': String(body.length) } });
const signal = () => new AbortController().signal;

function page({ count = 1, vids = ['v1'], accessible = count, episode = 1 }) {
  return `window._ROUTER_DATA = ${JSON.stringify({ loaderData: { 'player_(series_id)/page': {
    isSuccess: true, series_id: '123', vid: vids[episode - 1], seriesDetail: {
      series_id: '123', series_name: 'Public fixture', episode_cnt: count, accessible_episode_cnt: accessible, vid_list: vids,
    }, video_player_info: { main_url: 'https://v1-hgweb.qznovelvod.com/public', duration: 10 },
  } } })};`;
}

async function fixture(t, details) {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-public-catalog-'));
  const calls = [];
  const client = new HongguoDownloadClient({ sourceMode: 'public', outputRoot: root, retries: 0 }, {
    request: async (url, kind) => {
      calls.push({ url, kind });
      if (kind === 'media') return reply(media);
      const episode = Number(new URL(url).pathname.split('/')[3] ?? 1);
      return reply(Buffer.from(page({ ...details, episode })));
    },
    // Container checks use actual bytes; the codec seam supplies a controlled verdict.
    processMedia: async (_media, { inputPath }) => ({ processedPath: inputPath, durationSeconds: 10,
      fullDecodeChecked: true, validationLevel: 'ffprobe-full-decode-sha256' }),
  });
  t.after(async () => { try { await client.dispose(); } finally { await rm(root, { recursive: true, force: true }); } });
  return { root, client, calls };
}

for (const count of [2, Number.MAX_SAFE_INTEGER]) {
  test(`rejects a one-video catalog declaring ${count} episodes before planning or output`, async t => {
    const details = { count, accessible: 1, vids: ['v1'] };
    assert.throws(() => parsePlayer(page(details), '123', 1), /目录|集数|数据/);
    const f = await fixture(t, details);
    for (const result of [await f.client.info({ seriesIds: ['123'] }), await f.client.download({ seriesIds: ['123'] })]) {
      assert.equal(result.ok, false);
      assert.equal(result.complete, false);
      assert.equal(result.code, 'invalid_player');
    }
    assert.equal(f.calls.some(call => call.kind === 'media'), false);
    assert.deepEqual(await readdir(f.root), []);
  });
}

for (const vids of [[null], [42], [''], [' '], ['v\0'], ['v\n'], [' v1'], ['v1 '], ['v1', null], ['v1', ''], ['v1', 'v1']]) {
  test(`rejects invalid or duplicated public video IDs ${JSON.stringify(vids)}`, async t => {
    const details = { count: vids.length, accessible: 1, vids };
    assert.throws(() => parsePlayer(page(details), '123', 1), /目录|集数|数据|播放集/);
    const f = await fixture(t, details);
    const result = await f.client.info({ seriesIds: ['123'] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_player');
  });
}

test('public catalog planning retains the returned video IDs in their declared order', async t => {
  const vids = ['returned-second', 'returned-first'];
  const f = await fixture(t, { count: vids.length, vids });
  const catalog = await f.client.catalog('123', 'public', signal());
  assert.deepEqual(catalog.episodes.map(({ index, vid }) => ({ index, vid })), [
    { index: 1, vid: vids[0] }, { index: 2, vid: vids[1] },
  ]);
});

for (const count of [209, 10001]) {
  test(`accepts every returned entry of a ${count}-episode public catalog without an episode cap`, async t => {
    const vids = Array.from({ length: count }, (_, index) => `public-${index + 1}`);
    const f = await fixture(t, { count, vids });
    const info = await f.client.info({ seriesIds: ['123'] });
    assert.equal(info.ok, true);
    assert.equal(info.items[0].episodeCount, count);
    assert.equal(info.items[0].completeCatalog, true);
    assert.equal(info.items[0].fullSeriesAvailable, true);
    const catalog = await f.client.catalog('123', 'public', signal());
    assert.equal(catalog.episodes.length, vids.length);
    assert.equal(catalog.episodes.at(-1).vid, vids.at(-1));
    const download = await f.client.download({ seriesIds: ['123'], episodes: [count] });
    assert.equal(download.ok, true);
    assert.equal(download.complete, false);
    assert.equal(download.items[0].downloadedEpisodeCount, 1);
    assert.equal(download.items[0].episodes[0].index, count);
    assert.equal(f.calls.filter(call => call.kind === 'media').length, 1);
  });
}

test('a complete public ID list with only one accessible episode remains a preview', async t => {
  const vids = ['public-1', 'public-2'];
  const details = { count: vids.length, accessible: 1, vids };
  const inaccessible = parsePlayer(page({ ...details, episode: 2 }), '123', 2);
  assert.deepEqual(inaccessible.vids, vids);
  assert.equal(inaccessible.info.publicPlaybackAvailable, false);
  assert.equal(inaccessible.mediaUrl, null);
  const f = await fixture(t, details);
  const info = await f.client.info({ seriesIds: ['123'] });
  assert.equal(info.ok, true);
  assert.equal(info.items[0].completeCatalog, true);
  assert.equal(info.items[0].fullSeriesAvailable, false);
  const full = await f.client.download({ seriesIds: ['123'] });
  assert.equal(full.ok, false);
  assert.equal(full.complete, false);
  assert.equal(full.code, 'public_preview_only');
  assert.equal(f.calls.some(call => call.kind === 'media'), false);
  const preview = await f.client.download({ seriesIds: ['123'], episodes: [1] });
  assert.equal(preview.ok, true);
  assert.equal(preview.complete, false);
  assert.equal(preview.items[0].episodeCount, 2);
  assert.equal(preview.items[0].downloadedEpisodeCount, 1);
});
