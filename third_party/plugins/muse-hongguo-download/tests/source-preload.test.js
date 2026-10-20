/** Video-tab media requests keep their exact episode identity and omit incompatible native signatures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { SourceCatalog } from '../src/source.js';
import { resolveConfig } from '../src/config.js';
import { DownloadError } from '../src/errors.js';

const path = '/reading/bookapi/video_tab/multi_video_model/v1/';
const signatures = ['x-argus', 'x-gorgon', 'x-khronos', 'x-ladon', 'x-helios', 'x-medusa', 'x-neptune', 'x-soter'];
const reply = value => Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), { statusCode: 200, headers: {} });
const model = { video_list: [{ main_url: 'https://v1.qznovelvod.com/fixture', video_meta: { size: 123 } }] };

async function fixture(t, response, { interval = 0, retries = 0, now, wait, request } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-hongguo-preload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inherited = Object.fromEntries(signatures.map(name => [name.toUpperCase(), 'PRIVATE_STALE_SIGNATURE']));
  await writeFile(join(root, 'config.json'), JSON.stringify({ api_host: 'api.example.org', base_query: { aid: '8662' },
    session_headers: { ...inherited, 'sdk-version': '2', Cookie: 'PRIVATE_COOKIE', 'X-TT-Token': 'PRIVATE_TOKEN' } }));
  await writeFile(join(root, 'devices.json'), JSON.stringify(['synthetic-local', 'synthetic-other']
    .map(device => ({ query: { device }, user_agent: 'synthetic' }))));
  let starts = 0, signs = 0;
  const calls = [];
  const source = new SourceCatalog(resolveConfig({ legacyAppDir: root, retries, retryDelayMs: 0, mediaRequestIntervalMs: interval }), {
    randomIndex: () => 0,
    ...(now ? { now } : {}), ...(wait ? { wait } : {}),
    signer: { async ensure() { starts++; return { url: 'http://127.0.0.1:1234/sign', token: '' }; } },
    sign: async () => { signs++; return reply({ 'x-argus': 'PRIVATE_INCOMPATIBLE_SIGNATURE' }); },
    request: async (url, kind, signal, options) => {
      signal.throwIfAborted();
      calls.push({ url: new URL(url), kind, headers: options.headers, body: options.body ? JSON.parse(options.body) : undefined });
      if (Object.keys(options.headers).some(name => signatures.includes(name.toLowerCase()))) {
        return Object.assign(Readable.from([]), { statusCode: 200, headers: { 'content-length': '0' } });
      }
      const result = request ? request(signal) : reply(response);
      return result;
    },
  });
  return { source, calls, counts: () => ({ starts, signs }) };
}

test('the video-tab protocol resolves the requested episode without launching or sending the native signer', async t => {
  const f = await fixture(t, { Code: 0, data: { video_model_data: { episode: { video_model: JSON.stringify(model) } } } });
  const result = await f.source.videoUrls(['episode', 'episode'], new AbortController().signal);
  assert.deepEqual([...result.keys()], ['episode']);
  assert.equal(result.get('episode').expectedBytes, 123);
  assert.deepEqual(f.counts(), { starts: 0, signs: 0 });
  assert.equal(f.calls.length, 1);
  const request = f.calls[0];
  assert.equal(request.url.pathname, path);
  assert.equal(request.url.searchParams.get('device'), 'synthetic-local');
  assert.equal(request.body, undefined);
  assert.equal(request.url.searchParams.get('video_id'), 'episode');
  assert.equal(request.url.searchParams.get('need_all_video_definition'), 'true');
  assert.equal(request.headers['sdk-version'], '2');
  assert.ok(!Object.keys(request.headers).some(name => [...signatures, 'cookie', 'x-tt-token'].includes(name.toLowerCase())));
  assert.ok(!JSON.stringify(request.headers).includes('PRIVATE_'));
});

test('concurrent media lookups share their configured spacing and start request deadlines after waiting', async t => {
  let clock = 0;
  const budgets = [], starts = [], waits = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    budgets.push({ at: clock, milliseconds });
    return new AbortController().signal;
  });
  const f = await fixture(t, { data: { video_model_data: { episode: { video_model: model } } } }, {
    interval: 6000, now: () => clock,
    wait: async (milliseconds, signal) => { signal.throwIfAborted(); waits.push(milliseconds); clock += milliseconds; },
    request: () => { starts.push(clock); return reply({ data: { video_model_data: { episode: { video_model: model } } } }); },
  });
  await Promise.all(Array.from({ length: 3 }, () => f.source.videoUrls(['episode'], new AbortController().signal)));
  assert.deepEqual(starts, [0, 6000, 12000]);
  assert.deepEqual(waits, [6000, 6000]);
  assert.deepEqual(budgets, starts.map(at => ({ at, milliseconds: 20000 })));
});

test('cancelling a queued media wait dispatches no request and releases later callers', async t => {
  let clock = 0, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let block = true;
  const f = await fixture(t, { data: { video_model_data: { episode: { video_model: model } } } }, {
    interval: 6000, now: () => clock,
    wait: async (milliseconds, signal) => {
      if (!block) { clock += milliseconds; return; }
      entered();
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  await f.source.videoUrls(['episode'], new AbortController().signal);
  const controller = new AbortController();
  const pending = f.source.videoUrls(['episode'], controller.signal);
  const rejected = assert.rejects(pending, error => error === controller.signal.reason);
  await waiting; controller.abort(); await rejected;
  assert.equal(f.calls.length, 1);
  block = false;
  await f.source.videoUrls(['episode'], new AbortController().signal);
  assert.equal(f.calls.length, 2);
});

test('a media request timeout is terminal and does not rotate the retained device', async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const f = await fixture(t, {}, { request: signal => {
    const pending = new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    controller.abort(new Error('synthetic request deadline'));
    return pending;
  } });
  await assert.rejects(f.source.videoUrls(['episode'], new AbortController().signal), error => error.code === 'source_timeout'
    && error.sourceStage === 'video_model' && error.retryable === false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.source.deviceIndex, 0);
});

test('a transient source connection failure retries within budget on the same device', async t => {
  let attempts = 0;
  const f = await fixture(t, {}, { retries: 2, request: () => {
    if (++attempts < 3) throw new DownloadError('network', 'synthetic connection reset');
    return reply({ data: { video_model_data: { episode: { video_model: model } } } });
  } });
  assert.equal((await f.source.videoUrls(['episode'], new AbortController().signal)).size, 1);
  assert.equal(f.calls.length, 3);
  assert.equal(f.source.deviceIndex, 0);
});

test('exhausted connection retries stop with safe stage metadata and no device rotation', async t => {
  const f = await fixture(t, {}, { retries: 2, request: () => { throw new DownloadError('network', 'synthetic connection reset'); } });
  await assert.rejects(f.source.videoUrls(['episode'], new AbortController().signal), error => error.code === 'network'
    && error.sourceStage === 'video_model' && error.retryable === false);
  assert.equal(f.calls.length, 3);
  assert.equal(f.source.deviceIndex, 0);
});

test('only transient HTTP responses use the source retry budget', async t => {
  for (const status of [429, 503, 401, 403, 404]) {
    const f = await fixture(t, {}, { retries: 1, request: () => Object.assign(Readable.from([]), { statusCode: status, headers: {} }) });
    await assert.rejects(f.source.videoUrls(['episode'], new AbortController().signal), error => error.code === 'http_error'
      && error.httpStatus === status);
    assert.equal(f.calls.length, [429, 503].includes(status) ? 2 : 1);
    assert.equal(f.source.deviceIndex, 0);
  }
});

test('interrupted response streams retry bounded reads without returning transport diagnostics', async t => {
  const f = await fixture(t, {}, { retries: 1, request: () => Object.assign(Readable.from((async function* () {
    yield Buffer.from('{');
    throw new Error('PRIVATE_TRANSPORT_DIAGNOSTICS');
  })()), { statusCode: 200, headers: { 'content-length': '100' } }) });
  await assert.rejects(f.source.videoUrls(['episode'], new AbortController().signal), error => error.code === 'incomplete_response'
    && error.retryable === false && error.sourceStage === 'video_model' && !error.message.includes('PRIVATE_'));
  assert.equal(f.calls.length, 2);
});

test('an unclassified POST never acquires automatic connection retries', async t => {
  const f = await fixture(t, {}, { retries: 2 });
  let calls = 0;
  f.source.request = async () => { calls++; throw new DownloadError('network', 'synthetic connection reset'); };
  await assert.rejects(f.source.api('/unclassified-post', {}, new AbortController().signal), error => error.code === 'network');
  assert.equal(calls, 1);
});

test('one empty media response after verified media cools down and recovers on the same device', async t => {
  let attempts = 0, clock = 0;
  const waits = [], budgets = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => { budgets.push({ clock, milliseconds }); return new AbortController().signal; });
  const f = await fixture(t, {}, { retries: 2, interval: 6000, now: () => clock,
    wait: async milliseconds => { waits.push(milliseconds); clock += milliseconds; },
    request: () => ++attempts === 2 ? Object.assign(Readable.from([]), { statusCode: 200, headers: { 'content-length': '0' } })
      : reply({ data: { video_model_data: { episode: { video_model: model } } } }),
  });
  await f.source.videoUrls(['episode'], new AbortController().signal);
  assert.equal((await f.source.videoUrls(['episode'], new AbortController().signal)).size, 1);
  assert.deepEqual(waits, [6000, 120000]);
  assert.deepEqual(budgets.map(budget => budget.clock), [0, 6000, 126000]);
  assert.equal(f.calls.length, 3);
  assert.equal(f.source.deviceIndex, 0);
});

test('repeated empty media responses stop after one recovery without resetting the device', async t => {
  let attempts = 0, clock = 0;
  const f = await fixture(t, {}, { retries: 2, now: () => clock,
    wait: async milliseconds => { clock += milliseconds; },
    request: () => ++attempts === 1 ? reply({ data: { video_model_data: { episode: { video_model: model } } } })
      : Object.assign(Readable.from([]), { statusCode: 200, headers: {} }),
  });
  await f.source.videoUrls(['episode'], new AbortController().signal);
  await assert.rejects(f.source.videoUrls(['episode'], new AbortController().signal), error => error.code === 'empty_source_response'
    && error.retryable === false);
  assert.equal(f.calls.length, 3);
  assert.equal(f.source.deviceIndex, 0);
});

test('a first-use empty response never starts cooldown retries without verified media', async t => {
  const f = await fixture(t, {}, { retries: 2, request: () => Object.assign(Readable.from([]), { statusCode: 200, headers: {} }) });
  await assert.rejects(f.source.videoUrls(['episode'], new AbortController().signal), error => error.code === 'empty_source_response');
  assert.equal(f.calls.length, 1);
});

test('cancellation during source cooldown sends no recovery request', async t => {
  let attempts = 0, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, {}, { retries: 2, now: () => 0,
    wait: async (milliseconds, signal) => {
      assert.equal(milliseconds, 120000);
      entered();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    request: () => ++attempts === 1 ? reply({ data: { video_model_data: { episode: { video_model: model } } } })
      : Object.assign(Readable.from([]), { statusCode: 200, headers: {} }),
  });
  await f.source.videoUrls(['episode'], new AbortController().signal);
  const controller = new AbortController();
  const pending = f.source.videoUrls(['episode'], controller.signal);
  const rejected = assert.rejects(pending, error => error === controller.signal.reason);
  await waiting; controller.abort(); await rejected;
  assert.equal(f.calls.length, 2);
  assert.equal(f.source.deviceIndex, 0);
});

test('video-tab resolution rejects a different episode and the obsolete unkeyed response', async t => {
  for (const response of [
    { data: { video_model_data: { another: { video_model: model } } } },
    { data: { video_model: model } },
  ]) {
    const f = await fixture(t, response);
    await assert.rejects(f.source.videoUrls(['episode'], new AbortController().signal), error => error.code === 'missing_episode_url');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url.pathname, path);
    assert.deepEqual(f.counts(), { starts: 0, signs: 0 });
  }
});


test('a batch requires every requested keyed model and never substitutes an unrelated video', async t => {
  const f = await fixture(t, { data: { video_model_data: { first: { video_model: model }, unrelated: { video_model: model } } } });
  await assert.rejects(f.source.videoUrls(['first', 'second'], new AbortController().signal), { code: 'missing_episode_url' });
  assert.equal(f.calls[0].url.searchParams.get('video_id'), 'first,second');
  assert.equal(f.calls.length, 1);
});
