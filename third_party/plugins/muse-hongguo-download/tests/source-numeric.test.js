/** Synthetic raw JSON fixtures preserve decimal ids without platform calls or private source files. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { resolveConfig } from '../src/config.js';
import { SourceCatalog } from '../src/source.js';

const id = '1234567890123456789';
const adjacentId = '1234567890123456790';
const signal = () => new AbortController().signal;
const rawReply = text => Object.assign(Readable.from([Buffer.from(text)]), { statusCode: 200, headers: {} });
const detailJson = returnedId => `{"code":0,"data":{"${id}":{"video_data":{"series_id":${returnedId},"series_title":"Synthetic series","episode_cnt":1,"video_list":[{"vid_index":1,"vid":"fixture-video","duration":12.5}]}}}}`;

async function fixture(t, response, configJson = '{"api_host":"api.example.org","base_query":{"app":1},"session_headers":{}}',
  devicesJson = '[{"query":{"device":1},"user_agent":"synthetic-device"}]') {
  const directory = await mkdtemp(join(tmpdir(), 'muse-hongguo-numeric-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'config.json'), configJson);
  await writeFile(join(directory, 'devices.json'), devicesJson);
  const signedUrls = [], requests = [];
  const source = new SourceCatalog(resolveConfig({ legacyAppDir: directory, signServer: 'http://127.0.0.1:8123',
    signTokenEnv: 'MUSE_HONGGUO_NUMERIC_FIXTURE_TOKEN', retries: 0 }), {
    randomIndex: () => 0,
    sign: async (_url, payload) => { signedUrls.push(payload.url); return rawReply('{}'); },
    request: async (url, kind, active, options) => {
      active.throwIfAborted();
      requests.push({ url, kind, options });
      return rawReply(response);
    },
  });
  return { source, signedUrls, requests };
}

test('an unquoted 19-digit series id matches the requested complete catalog exactly', async t => {
  const f = await fixture(t, detailJson(id));
  const result = await f.source.episodes(id, signal());
  assert.equal(result.seriesId, id);
  assert.equal(result.episodeCount, 1);
  assert.equal(result.episodes[0].durationSeconds, 12.5);
  assert.equal(JSON.parse(f.requests[0].options.body).series_id, id);
});

test('adjacent 19-digit series ids remain distinct even when JavaScript numbers coincide', async t => {
  assert.equal(BigInt(adjacentId) - BigInt(id), 1n);
  assert.equal(Number(adjacentId), Number(id));
  const f = await fixture(t, detailJson(adjacentId));
  await assert.rejects(f.source.episodes(id, signal()), error => error.code === 'series_mismatch');
  assert.equal(f.requests.length, 1);
});

test('unquoted device and base query ids keep their original decimals in signer and API URLs', async t => {
  const f = await fixture(t, '{"code":0}',
    `{"api_host":"api.example.org","base_query":{"install_id":${id}},"session_headers":{}}`,
    `[{"query":{"device_id":${adjacentId}},"user_agent":"synthetic-device"}]`);
  await f.source.api('/numeric-fixture', {}, signal());
  for (const value of [f.signedUrls[0], f.requests[0].url]) {
    const url = new URL(value);
    assert.equal(url.searchParams.get('install_id'), id);
    assert.equal(url.searchParams.get('device_id'), adjacentId);
  }
  assert.equal(f.signedUrls[0], f.requests[0].url);
});

test('small integers and decimals remain numbers in configuration and API responses', async t => {
  const f = await fixture(t, '{"code":0,"small":7,"negative":-3,"fraction":12.5,"largestSafe":9007199254740991,"nested":[0,2.25]}',
    '{"api_host":"api.example.org","base_query":{"app":7,"scale":1.25},"session_headers":{}}',
    '[{"query":{"screen_width":900,"pixel_ratio":2.5},"user_agent":"synthetic-device"}]');
  const loaded = await f.source.load();
  assert.deepEqual(loaded.source.base_query, { app: 7, scale: 1.25 });
  assert.deepEqual(loaded.devices[0].query, { screen_width: 900, pixel_ratio: 2.5 });
  assert.deepEqual(await f.source.api('/numeric-fixture', {}, signal()), {
    code: 0, small: 7, negative: -3, fraction: 12.5, largestSafe: Number.MAX_SAFE_INTEGER, nested: [0, 2.25],
  });
});
