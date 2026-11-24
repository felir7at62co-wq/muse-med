import test from 'node:test';
import assert from 'node:assert/strict';
import { JackotomSource } from '../src/jackotom.js';
import { resolveConfig } from '../src/config.js';
const signal = () => new AbortController().signal;
const id = '7691229866846325822', vid = '7691231894586805273';
const catalog = { series_id: id, series_title: '目录测试', total: 1, episodes: [{ vid, vid_index: 1, title: '第1集' }] };
test('preserves long ids and checks complete ordered unlocked catalogs', async () => {
  const engine = { fetchEpisodeList: async () => catalog };
  const source = new JackotomSource(resolveConfig(), engine);
  assert.equal((await source.episodes(id, signal())).episodes[0].vid, vid);
  for (const changed of [{ ...catalog, total: 2 }, { ...catalog, episodes: [{ vid, vid_index: 2 }] }, { ...catalog, episodes: [{ vid, vid_index: 1, locked: true }] }]) {
    engine.fetchEpisodeList = async () => changed;
    await assert.rejects(source.episodes(id, signal()), { code: 'invalid_catalog' });
  }
});
test('passes requested quality without exposing keys in catalog or changing episode identity', async () => {
  let options;
  const source = new JackotomSource(resolveConfig(), { fetchPlayUrlSingle: async (_vid, _id, o) => { options = o; return { vid, url: 'https://a.qznovelvod.com/video', contentKey: 'a'.repeat(32), width: 1080, height: 1920 }; } });
  const media = (await source.videoUrls([vid], signal(), id)).get(vid);
  assert.equal(options.quality, '1080p'); assert.equal(media.encryption.contentKey, 'a'.repeat(32));
});
test('stops on denied source and missing decoder configuration before subsequent episode requests', async () => {
  let calls = 0;
  const engine = { fetchPlayUrlSingle: async () => { calls++; return { error: 'private signed URL', url: null }; } };
  const source = new JackotomSource(resolveConfig(), engine);
  await assert.rejects(source.videoUrls([vid, '123'], signal(), id), error => error.code === 'source_unavailable' && !error.message.includes('private'));
  assert.equal(calls, 1);
  engine.fetchPlayUrlSingle = async () => ({ vid, url: 'https://a.qznovelvod.com/video', codec: 'bytevc2' });
  await assert.rejects(source.videoUrls([vid], signal(), id), { code: 'missing_bytevc2_runtime' });
});
test('pre-cancelled source lookup does no work', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const source = new JackotomSource(resolveConfig(), { fetchPlayUrlSingle: async () => { calls++; } });
  await assert.rejects(source.videoUrls([vid], controller.signal, id)); assert.equal(calls, 0);
});

test('ByteVC2 sources reach conversion only with an explicitly configured decoder', async () => {
  const source = new JackotomSource(resolveConfig({ bytevc2Executable: '/runtime/librempeg' }), {
    fetchPlayUrlSingle: async () => ({ vid, url: 'https://a.qznovelvod.com/video', codec: 'bytevc2', width: 1080, height: 1920, duration: 12.34 }) });
  const media = (await source.videoUrls([vid], signal(), id)).get(vid);
  assert.equal(media.codec, 'bytevc2');
  assert.equal(media.encryption, null);
  assert.equal(media.expectedWidth, 1080);
});

test('retries transient source failures with a fresh lookup and then succeeds', async () => {
  const calls = [];
  const engine = { fetchPlayUrlSingle: async (_vid, _id, options) => {
    calls.push(options.force === true);
    return calls.length < 3 ? { url: null, error: 'private detail', code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'app', code: 'TIMEOUT', message: 'private' }] }
      : { vid, url: 'https://a.qznovelvod.com/video', width: 1080, height: 1920 };
  } };
  const source = new JackotomSource(resolveConfig({ sourceRetryDelayMs: 0 }), engine);
  assert.equal((await source.videoUrls([vid], signal(), id)).get(vid).url, 'https://a.qznovelvod.com/video');
  assert.deepEqual(calls, [false, true, true]);
});

test('reports enumerated failure codes without retrying an explicit App refusal', async () => {
  let calls = 0;
  const engine = { fetchPlayUrlSingle: async () => { calls++; return { url: null, error: 'private signed URL', code: 'SOURCE_UNAVAILABLE',
    sources: [{ source: 'web', code: 'PREVIEW_ONLY', message: 'private' }, { source: 'app', code: 'HTTP_429', message: 'private' }, { source: 'app', code: 'bad code' }] }; } };
  const source = new JackotomSource(resolveConfig({ sourceRetryDelayMs: 0 }), engine);
  await assert.rejects(source.videoUrls([vid], signal(), id), error => {
    assert.equal(error.code, 'source_unavailable'); assert.equal(error.retryable, false); assert.equal(error.upstreamCode, 'SOURCE_UNAVAILABLE');
    assert.deepEqual(error.sourceFailures, [{ source: 'web', code: 'PREVIEW_ONLY' }, { source: 'app', code: 'HTTP_429' }]);
    assert.match(error.message, /网页：PREVIEW_ONLY；App：HTTP_429/); assert.ok(!error.message.includes('private'));
    return true;
  });
  assert.equal(calls, 1);
});

test('reports the enumerated registration reason without disclosing source details', async () => {
  const source = new JackotomSource(resolveConfig(), { fetchPlayUrlSingle: async () => ({
    url: null, code: 'SOURCE_UNAVAILABLE',
    sources: [
      { source: 'app', code: 'DEVICE_REGISTRATION_FAILED', registrationFailure: 'INVALID_RESPONSE', message: 'private signed URL' },
      { source: 'app', code: 'DEVICE_REGISTRATION_FAILED', registrationFailure: 'untrusted response body' },
      { source: 'web', code: 'HTTP_404', registrationFailure: 'HTTP_429' },
    ],
  }) });
  await assert.rejects(source.videoUrls([vid], signal(), id), {
    code: 'source_unavailable', retryable: false,
    sourceFailures: [
      { source: 'app', code: 'DEVICE_REGISTRATION_FAILED', registrationFailure: 'INVALID_RESPONSE' },
      { source: 'app', code: 'DEVICE_REGISTRATION_FAILED' },
      { source: 'web', code: 'HTTP_404' },
    ],
  });
});

test('marks a transient failure retryable after the configured retries are spent', async () => {
  let calls = 0;
  const engine = { fetchPlayUrlSingle: async () => { calls++; return { url: null, code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'app', code: 'NETWORK_ERROR' }] }; } };
  const source = new JackotomSource(resolveConfig({ sourceRetries: 1, sourceRetryDelayMs: 0 }), engine);
  await assert.rejects(source.videoUrls([vid], signal(), id), { code: 'source_unavailable', retryable: true });
  assert.equal(calls, 2);
});

test('cancellation during a retry wait stops further lookups', async () => {
  const controller = new AbortController(); let calls = 0;
  const engine = { fetchPlayUrlSingle: async () => { calls++; setTimeout(() => controller.abort(), 5); return { url: null, sources: [{ source: 'app', code: 'TIMEOUT' }] }; } };
  const source = new JackotomSource(resolveConfig({ sourceRetryDelayMs: 60000 }), engine);
  await assert.rejects(source.videoUrls([vid], controller.signal, id));
  assert.equal(calls, 1);
});
