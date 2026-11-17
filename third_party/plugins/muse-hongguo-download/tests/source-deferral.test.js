/** Transient open-engine lookup failures defer one episode instead of stopping the series. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HongguoDownloadClient } from '../src/client.js';

const box = (type, payload = Buffer.alloc(0)) => {
  const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type, 4);
  return Buffer.concat([header, payload]);
};
const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', box('trak', box('mdia'))), box('mdat', Buffer.from('deferral fixture'))]);
const empty = { url: null, code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'web', code: 'HTTP_404' }, { source: 'app', code: 'EMPTY_RESPONSE' }, { source: 'api', code: 'EMPTY_RESPONSE' }] };

async function fixture(t, playable) {
  const root = await mkdtemp(join(tmpdir(), 'muse-hongguo-deferral-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lookups = [];
  const engine = {
    async fetchEpisodeList(id) {
      return { series_id: id, series_title: 'Deferral', total: 4, episodes: [1, 2, 3, 4].map(index => ({ vid: `${id}${index}`, vid_index: index, title: `第${index}集` })) };
    },
    async fetchPlayUrlSingle(vid) {
      lookups.push(vid);
      const answer = playable(vid, lookups.filter(item => item === vid).length);
      return answer === true ? { vid, url: `https://media.jspcdn.cn/${vid}`, width: 1080, height: 1920, duration: 10, codec: 'h264' } : answer;
    },
  };
  const processMedia = async (_media, { inputPath }) => ({ processedPath: inputPath, durationSeconds: 10, width: 1080, height: 1920,
    videoCodec: 'h264', fullDecodeChecked: true, validationLevel: 'ffprobe-full-decode-sha256' });
  const request = async () => Object.assign(Readable.from([mp4]), { statusCode: 200, headers: { 'content-length': String(mp4.length) } });
  const client = new HongguoDownloadClient({ outputRoot: root, quality: 'auto', retries: 0, mediaRequestIntervalMs: 0,
    sourceRetryDelayMs: 0, deferredSourceCooldownMs: 0 }, { engine, request, processMedia });
  t.after(() => client.dispose());
  return { client, lookups };
}

test('an episode whose sources are temporarily empty is retried after the rest of the series', async t => {
  const f = await fixture(t, (vid, count) => vid !== '92' || count > 3 || empty);
  const result = await f.client.download({ seriesIds: ['9'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.deepEqual(f.lookups, ['91', '92', '92', '92', '93', '94', '92']);
});

test('an episode that stays empty leaves the other episodes downloaded and a retryable error', async t => {
  const f = await fixture(t, vid => vid !== '92' || empty);
  const result = await f.client.download({ seriesIds: ['9'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'source_unavailable');
  assert.equal(result.retryable, true);
  assert.equal(result.retainedEpisodeCount, 3);
  assert.match(result.message, /第 2 集延后重试仍未取到片源/);
  assert.deepEqual(result.sourceFailures, empty.sources);
});

test('an explicit App refusal still stops the series without deferral', async t => {
  const refused = { url: null, code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'app', code: 'HTTP_429' }] };
  const f = await fixture(t, vid => vid !== '92' || refused);
  const result = await f.client.download({ seriesIds: ['9'] });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(f.lookups.filter(vid => vid === '92').length, 1);
  assert.ok(!f.lookups.includes('93'));
});
