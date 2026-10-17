/** Owner-local range fixtures synchronize cancellation and response closure without live CDNs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { transferMedia } from '../src/transfer.js';
import { DownloadError } from '../src/errors.js';

const payload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reply = (bytes, statusCode = 200, headers = {}) => Object.assign(Readable.from([bytes]), {
  statusCode, headers: { 'content-length': String(bytes.length), 'content-type': 'video/mp4', ...headers },
});
const advertised = (headers = {}) => reply(payload, 200, { 'accept-ranges': 'bytes', etag: '"revision-1"', ...headers });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-range-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  t.after(() => controller.abort());
  return { path: join(root, 'episode.part'), signal: controller.signal, controller,
    url: 'https://media.example.org/video', headers: { referer: 'https://example.org/' },
    allowedHosts: ['media.example.org'], allowedPorts: [443], maxBytes: 1000,
    expectedBytes: payload.length, connections: 4, minSegmentBytes: 8 };
}

function ranges(t, f, variant) {
  const calls = [], streams = [];
  const request = async (url, kind, signal, options) => {
    assert.equal(url, f.url); assert.equal(kind, 'media');
    assert.equal(options.allowedHosts, f.allowedHosts); assert.equal(options.allowedPorts, f.allowedPorts);
    assert.equal(options.headers.referer, f.headers.referer);
    signal.throwIfAborted();
    calls.push(options.headers);
    let response;
    if (!options.headers.range) response = advertised();
    else {
      assert.equal(streams[0].closed, true, 'initial full stream closed before ranged requests');
      assert.equal(options.headers['if-match'], '"revision-1"');
      const [, lo, hi] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.range);
      const body = payload.subarray(Number(lo), Number(hi) + 1);
      response = variant?.({ body, lo: Number(lo), hi: Number(hi), calls, streams })
        ?? reply(body, 206, { 'content-range': `bytes ${lo}-${hi}/${payload.length}`, etag: '"revision-1"' });
    }
    streams.push(response); return response;
  };
  t.after(() => streams.forEach(stream => stream.destroy()));
  return { request, calls, streams };
}

test('exact parallel ranges produce the complete file hash and preserve request allowlists', async t => {
  const f = await fixture(t), r = ranges(t, f);
  const result = await transferMedia({ ...f, request: r.request });
  assert.deepEqual(result, { bytes: payload.length, sha256: hash(payload) });
  assert.deepEqual(await readFile(f.path), payload);
  assert.deepEqual(r.calls.slice(1).map(h => h.range), ['bytes=0-11', 'bytes=12-23', 'bytes=24-35', 'bytes=36-48']);
  assert.equal(r.streams.every(s => s.closed), true);
});

for (const [name, headers] of [
  ['no range advertisement', { 'accept-ranges': '' }],
  ['weak ETag', { etag: 'W/"weak"' }],
  ['missing ETag', { etag: undefined }],
  ['unknown length', { 'content-length': undefined }],
]) {
  test(`${name} uses the original full response`, async t => {
    const f = await fixture(t); let calls = 0;
    const response = advertised(headers);
    const result = await transferMedia({ ...f, request: async () => { calls++; return response; } });
    assert.equal(calls, 1); assert.equal(result.sha256, hash(payload)); assert.equal(response.closed, true);
  });
}

test('segment minimum and configured single connection avoid extra requests', async t => {
  const f = await fixture(t);
  for (const [index, options] of [{ connections: 1 }, { minSegmentBytes: payload.length }].entries()) {
    let calls = 0;
    const result = await transferMedia({ ...f, ...options, path: `${f.path}${index}`,
      request: async () => { calls++; return advertised(); } });
    assert.equal(calls, 1); assert.equal(result.bytes, payload.length);
  }
});

for (const [name, change] of [
  ['HTTP 200', ({ body }) => reply(body, 200)],
  ['changed ETag', ({ body, lo, hi }) => reply(body, 206, { 'content-range': `bytes ${lo}-${hi}/${payload.length}`, etag: '"revision-2"' })],
  ['incorrect range', ({ body }) => reply(body, 206, { 'content-range': `bytes 1-2/${payload.length}`, etag: '"revision-1"' })],
  ['incorrect total', ({ body, lo, hi }) => reply(body, 206, { 'content-range': `bytes ${lo}-${hi}/${payload.length + 1}`, etag: '"revision-1"' })],
  ['incorrect length', ({ body, lo, hi }) => reply(body, 206, { 'content-length': String(body.length + 1), 'content-range': `bytes ${lo}-${hi}/${payload.length}`, etag: '"revision-1"' })],
  ['short body', ({ body, lo, hi }) => reply(body.subarray(0, -1), 206, { 'content-length': String(body.length), 'content-range': `bytes ${lo}-${hi}/${payload.length}`, etag: '"revision-1"' })],
  ['oversized body', ({ body, lo, hi }) => reply(Buffer.concat([body, Buffer.from('extra')]), 206, { 'content-length': String(body.length), 'content-range': `bytes ${lo}-${hi}/${payload.length}`, etag: '"revision-1"' })],
]) {
  test(`${name} cancels all segments then writes one full fallback`, async t => {
    const f = await fixture(t), r = ranges(t, f, change);
    const request = async (...args) => {
      if (r.calls.length > 1 && !args[3].headers.range) {
        assert.equal(r.streams.every(s => s.closed), true, 'all segmented responses closed before fallback');
      }
      return r.request(...args);
    };
    const result = await transferMedia({ ...f, request });
    assert.equal(r.calls.filter(h => !h.range).length, 2);
    assert.deepEqual(result, { bytes: payload.length, sha256: hash(payload) });
    assert.deepEqual(await readFile(f.path), payload); assert.equal(r.streams.every(s => s.closed), true);
  });
}

test('fallback waits for pending requests and their asynchronous stream destruction', async t => {
  const f = await fixture(t), requested = deferred(), releaseRequest = deferred(), closeStarted = deferred(), closeRelease = deferred();
  let calls = 0, fullCalls = 0;
  const held = new Readable({ read() {}, destroy(error, callback) {
    closeStarted.resolve(); closeRelease.promise.then(() => callback(error));
  } });
  t.after(() => { releaseRequest.resolve(); closeRelease.resolve(); held.destroy(); });
  const request = async (_url, _kind, _signal, { headers }) => {
    if (!headers.range) {
      fullCalls++;
      if (fullCalls === 2) assert.equal(held.closed, true);
      return advertised();
    }
    calls++;
    if (calls === 1) { requested.resolve(); await releaseRequest.promise; return Object.assign(held, { statusCode: 206, headers: {} }); }
    return reply(payload, 200);
  };
  const transfer = transferMedia({ ...f, request });
  await requested.promise;
  assert.equal(fullCalls, 1);
  releaseRequest.resolve(); await closeStarted.promise;
  assert.equal(fullCalls, 1, 'no fallback while a previous response is closing');
  closeRelease.resolve();
  assert.equal((await transfer).sha256, hash(payload)); assert.equal(fullCalls, 2);
});

test('parent abort closes and joins every active segment without a fallback', async t => {
  const f = await fixture(t), ready = deferred(), destroyStarted = deferred(), releaseClose = deferred();
  const streams = []; let ranged = 0, full = 0, destroying = 0;
  const request = async (_url, _kind, _signal, { headers }) => {
    if (!headers.range) { full++; return advertised(); }
    const [, lo, hi] = /^bytes=(\d+)-(\d+)$/.exec(headers.range);
    const stream = Object.assign(new Readable({ read() {}, destroy(error, callback) {
      if (++destroying === 4) destroyStarted.resolve();
      releaseClose.promise.then(() => callback(error));
    } }), { statusCode: 206, headers: { 'content-length': String(Number(hi) - Number(lo) + 1),
      'content-range': `bytes ${lo}-${hi}/${payload.length}`, etag: '"revision-1"' } });
    streams.push(stream); if (++ranged === 4) ready.resolve(); return stream;
  };
  t.after(() => { releaseClose.resolve(); streams.forEach(s => s.destroy()); });
  let settled = false;
  const transfer = transferMedia({ ...f, request }).finally(() => { settled = true; });
  const rejected = assert.rejects(transfer, error => error === f.signal.reason);
  await ready.promise; f.controller.abort(); await destroyStarted.promise;
  assert.equal(settled, false); assert.equal(full, 1);
  releaseClose.resolve(); await rejected;
  assert.equal(streams.every(s => s.closed), true); assert.equal(full, 1);
});

test('abort destroys a pending initial stream and closes it before returning', async t => {
  const f = await fixture(t), ready = deferred(), release = deferred();
  const stream = Object.assign(new Readable({ read() { ready.resolve(); }, destroy(error, callback) {
    release.promise.then(() => callback(error));
  } }), { statusCode: 200, headers: {} });
  t.after(() => { release.resolve(); stream.destroy(); });
  const transfer = transferMedia({ ...f, request: async () => stream });
  const rejected = assert.rejects(transfer, error => error === f.signal.reason);
  await ready.promise; f.controller.abort(); release.resolve(); await rejected;
  assert.equal(stream.closed, true);
});

for (const [name, response, expected, code] of [
  ['declared size exceeds limit', () => advertised({ 'content-length': '1001' }), payload.length, 'media_size'],
  ['invalid length', () => advertised({ 'content-length': '1e2' }), payload.length, 'media_size'],
  ['source size differs', () => advertised(), payload.length + 1, 'incomplete_media'],
  ['unknown length exceeds limit', () => reply(Buffer.alloc(1001), 200, { 'content-length': undefined }), null, 'media_size'],
  ['compressed body', () => advertised({ 'content-encoding': 'gzip' }), payload.length, 'encoding'],
  ['HTML body', () => advertised({ 'content-type': 'text/html' }), payload.length, 'invalid_media'],
  ['failed full response', () => reply(payload, 503), payload.length, 'http_error'],
  ['empty full body', () => reply(Buffer.alloc(0), 200, { 'content-length': undefined }), null, 'incomplete_media'],
]) {
  test(`${name} rejects and disposes the response`, async t => {
    const f = await fixture(t), stream = response(); let calls = 0;
    await assert.rejects(transferMedia({ ...f, expectedBytes: expected, request: async () => { calls++; return stream; } }), { code });
    assert.equal(stream.closed, true); assert.equal(calls, 1);
  });
}

test('single fallback failure does not issue another fallback', async t => {
  const f = await fixture(t); let full = 0;
  await assert.rejects(transferMedia({ ...f, request: async (_url, _kind, _signal, { headers }) => {
    if (headers.range) return reply(payload, 200);
    if (++full === 1) return advertised();
    return reply(payload.subarray(0, 10), 200);
  } }), { code: 'incomplete_media' });
  assert.equal(full, 2);
});

test('exclusive destination creation preserves an existing file', async t => {
  const f = await fixture(t); await writeFile(f.path, 'previous');
  await assert.rejects(transferMedia({ ...f, request: async () => { assert.fail('existing destination must be refused'); } }), { code: 'EEXIST' });
  assert.equal(await readFile(f.path, 'utf8'), 'previous');
});

test('transport error joins ranges and permits a single full fallback', async t => {
  const f = await fixture(t); let full = 0;
  const result = await transferMedia({ ...f, request: async (_url, _kind, _signal, { headers }) => {
    if (!headers.range) { full++; return advertised(); }
    throw Object.assign(new Error('connection reset'), { code: 'network' });
  } });
  assert.equal(full, 2); assert.equal(result.sha256, hash(payload));
});

for (const code of ['unsafe_url', 'unsafe_redirect', 'unsafe_dns', 'encoding', 'media_size', 'invalid_media']) {
  test(`segmented ${code} rejection propagates after join without retrying the URL`, async t => {
    const f = await fixture(t); let full = 0;
    const failure = Object.assign(new Error('controlled rejection'), { code });
    await assert.rejects(transferMedia({ ...f, request: async (_url, _kind, _signal, { headers }) => {
      if (!headers.range) { full++; return advertised(); }
      throw failure;
    } }), error => error === failure);
    assert.equal(full, 1);
  });
}

test('fallback truncates bytes left by a completed higher range', async t => {
  const f = await fixture(t), highWritten = deferred();
  const reduced = payload.subarray(0, 7); let full = 0;
  const request = async (_url, _kind, _signal, { headers }) => {
    if (!headers.range) return ++full === 1 ? advertised() : reply(reduced);
    const [, loText, hiText] = /^bytes=(\d+)-(\d+)$/.exec(headers.range);
    const lo = Number(loText), hi = Number(hiText);
    if (lo === 0) { await highWritten.promise; return reply(payload, 200); }
    const stream = reply(payload.subarray(lo, hi + 1), 206, {
      'content-range': `bytes ${lo}-${hi}/${payload.length}`, etag: '"revision-1"',
    });
    if (hi === payload.length - 1) stream.once('end', highWritten.resolve);
    return stream;
  };
  t.after(() => highWritten.resolve());
  const result = await transferMedia({ ...f, request, expectedBytes: null });
  assert.deepEqual(await readFile(f.path), reduced);
  assert.deepEqual(result, { bytes: reduced.length, sha256: hash(reduced) });
});

test('a joined security rejection takes priority over an earlier-index network error', async t => {
  const f = await fixture(t), ready = deferred(), releaseNetwork = deferred(), aborted = deferred(), releaseUnsafe = deferred();
  const securityError = Object.assign(new Error('unsafe redirect'), { code: 'unsafe_redirect' });
  let segments = 0, full = 0;
  const request = async (_url, _kind, signal, { headers }) => {
    if (!headers.range) { full++; return advertised(); }
    signal.addEventListener('abort', aborted.resolve, { once: true });
    if (++segments === 1) {
      await releaseNetwork.promise;
      throw Object.assign(new Error('connection reset'), { code: 'network' });
    }
    ready.resolve(); await releaseUnsafe.promise; throw securityError;
  };
  t.after(() => { releaseNetwork.resolve(); releaseUnsafe.resolve(); });
  const transfer = transferMedia({ ...f, connections: 2, request });
  const rejected = assert.rejects(transfer, error => error === securityError);
  await ready.promise; releaseNetwork.resolve(); await aborted.promise; releaseUnsafe.resolve();
  await rejected; assert.equal(full, 1, 'security rejection cannot trigger a full GET');
});

test('native stream read errors are reported as retryable media network errors', async t => {
  const f = await fixture(t);
  const stream = Object.assign(new Readable({ read() {
    this.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
  } }), { statusCode: 200, headers: {} });
  await assert.rejects(transferMedia({ ...f, request: async () => stream }), { code: 'network' });
  assert.equal(stream.closed, true);
});

async function httpFixture(t, handler) {
  const { createServer, get } = await import('node:http');
  const { once } = await import('node:events');
  const server = createServer(handler);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  const request = (_url, _kind, signal, { headers }) => new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${address.port}/media`, { signal, headers }, resolve)
      .on('error', error => reject(signal.aborted ? signal.reason : new DownloadError('network', 'fixture connection failed')));
  });
  return request;
}

test('real IncomingMessage closes an unread initial GET before issuing ranges', async t => {
  const f = await fixture(t), responses = []; let full = 0, ranged = 0;
  const request = await httpFixture(t, (req, res) => {
    if (!req.headers.range) {
      full++; res.writeHead(200, { 'content-length': payload.length, 'content-type': 'video/mp4', 'accept-ranges': 'bytes', etag: '"revision-1"' });
      res.write(payload.subarray(0, 1)); return;
    }
    ranged++;
    const [, lo, hi] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
    const body = payload.subarray(Number(lo), Number(hi) + 1);
    res.writeHead(206, { 'content-length': body.length, 'content-range': `bytes ${lo}-${hi}/${payload.length}`, etag: '"revision-1"' }); res.end(body);
  });
  const wrapped = async (...args) => {
    if (args[3].headers.range) assert.equal(responses[0].closed, true);
    const response = await request(...args); responses.push(response); return response;
  };
  const result = await transferMedia({ ...f, request: wrapped });
  assert.equal(full, 1); assert.equal(ranged, 4); assert.equal(result.sha256, hash(payload));
  assert.equal(responses.every(response => response.closed), true);
});

test('real IncomingMessage socket reset joins failed ranges before a valid full fallback', async t => {
  const f = await fixture(t), responses = []; let full = 0;
  const request = await httpFixture(t, (req, res) => {
    if (!req.headers.range) {
      if (++full === 1) {
        res.writeHead(200, { 'content-length': payload.length, 'content-type': 'video/mp4', 'accept-ranges': 'bytes', etag: '"revision-1"' });
        res.write(payload.subarray(0, 1));
      } else res.end(payload);
      return;
    }
    const [, lo, hi] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
    res.writeHead(206, { 'content-length': Number(hi) - Number(lo) + 1, 'content-range': `bytes ${lo}-${hi}/${payload.length}`, etag: '"revision-1"' });
    res.write(payload.subarray(Number(lo), Number(lo) + 1), () => res.destroy());
  });
  const wrapped = async (...args) => {
    if (!args[3].headers.range && full === 1) assert.equal(responses.every(response => response.closed), true);
    const response = await request(...args); responses.push(response); return response;
  };
  const result = await transferMedia({ ...f, request: wrapped });
  assert.equal(full, 2); assert.equal(result.sha256, hash(payload));
  assert.deepEqual(await readFile(f.path), payload);
  assert.equal(responses.every(response => response.closed), true);
});

test('header idle timeout cancels its request and waits for settlement', async t => {
  const f = await fixture(t), entered = deferred(), aborted = deferred(), release = deferred();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => release.resolve());
  let settled = false;
  const request = async (_url, _kind, signal) => {
    entered.resolve();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      aborted.resolve(); release.promise.then(() => reject(signal.reason));
    }, { once: true }));
  };
  const transfer = transferMedia({ ...f, request, idleTimeoutMs: 20 }).finally(() => { settled = true; });
  const rejected = assert.rejects(transfer, { code: 'network' });
  await entered.promise; t.mock.timers.tick(20); await aborted.promise;
  assert.equal(settled, false, 'timeout must join the owned request');
  release.resolve(); await rejected;
});

test('a response arriving after header timeout is closed before the timeout returns', async t => {
  const f = await fixture(t), entered = deferred(), aborted = deferred(), release = deferred();
  const response = reply(payload);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { release.resolve(); response.destroy(); });
  const transfer = transferMedia({ ...f, idleTimeoutMs: 20, request: async (_url, _kind, signal) => {
    signal.addEventListener('abort', aborted.resolve, { once: true });
    entered.resolve(); await release.promise; return response;
  } });
  const rejected = assert.rejects(transfer, { code: 'network' });
  await entered.promise; t.mock.timers.tick(20); await aborted.promise;
  release.resolve(); await rejected; assert.equal(response.closed, true);
});

function observeReads(stream, count) {
  const starts = Array.from({ length: count }, deferred);
  const original = stream[Symbol.asyncIterator].bind(stream);
  stream[Symbol.asyncIterator] = () => {
    const iterator = original(); let next = 0;
    return { next() { starts[next++]?.resolve(); return iterator.next(); }, return: () => iterator.return() };
  };
  return starts;
}

test('midstream idle timeout destroys and joins the silent response', async t => {
  const f = await fixture(t), closing = deferred(), releaseClose = deferred();
  const response = Object.assign(new Readable({ read() {}, destroy(error, callback) {
    closing.resolve(); releaseClose.promise.then(() => callback(error));
  } }), { statusCode: 200, headers: {} });
  const [waiting] = observeReads(response, 1);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { releaseClose.resolve(); response.destroy(); });
  let settled = false;
  const transfer = transferMedia({ ...f, idleTimeoutMs: 20, request: async () => response }).finally(() => { settled = true; });
  const rejected = assert.rejects(transfer, { code: 'network' });
  await waiting.promise; t.mock.timers.tick(20); await closing.promise;
  assert.equal(settled, false, 'timeout must wait for response close');
  releaseClose.resolve(); await rejected; assert.equal(response.closed, true);
});

test('each received chunk resets idle time instead of limiting the entire transfer', async t => {
  const f = await fixture(t);
  const chunks = [payload.subarray(0, 10), payload.subarray(10, 20), payload.subarray(20, 30), payload.subarray(30)];
  const response = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} });
  const waiting = observeReads(response, chunks.length + 1);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => response.destroy());
  let active;
  const transfer = transferMedia({ ...f, idleTimeoutMs: 20, request: async (_url, _kind, signal) => { active = signal; return response; } });
  for (const [index, chunk] of chunks.entries()) {
    await waiting[index].promise;
    t.mock.timers.tick(15); assert.equal(active.aborted, false);
    response.push(chunk);
  }
  await waiting[chunks.length].promise; response.push(null);
  assert.deepEqual(await transfer, { bytes: payload.length, sha256: hash(payload) });
  assert.equal(active.aborted, false, '60 ms of progress must survive a 20 ms idle deadline');
});

test('parent cancellation wins over an idle deadline and never falls back', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), aborted = deferred();
  const reason = new Error('caller stopped'); let calls = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => release.resolve());
  const transfer = transferMedia({ ...f, idleTimeoutMs: 20, request: async (_url, _kind, signal) => {
    calls++; entered.resolve();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      aborted.resolve(); release.promise.then(() => reject(signal.reason));
    }, { once: true }));
  } });
  const rejected = assert.rejects(transfer, error => error === reason);
  await entered.promise; f.controller.abort(reason); await aborted.promise;
  t.mock.timers.tick(20); release.resolve(); await rejected; assert.equal(calls, 1);
});

test('silent ranged responses join before the one full fallback', async t => {
  const f = await fixture(t), waiting = deferred(), streams = []; let full = 0, reads = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => streams.forEach(stream => stream.destroy()));
  const request = async (_url, _kind, _signal, { headers }) => {
    if (!headers.range) {
      if (++full === 2) assert.equal(streams.every(stream => stream.closed), true);
      return advertised();
    }
    const [, lo, hi] = /^bytes=(\d+)-(\d+)$/.exec(headers.range);
    const stream = Object.assign(new Readable({ read() {} }), { statusCode: 206,
      headers: { 'content-length': String(Number(hi) - Number(lo) + 1), 'content-range': `bytes ${lo}-${hi}/${payload.length}`, etag: '"revision-1"' } });
    const iterator = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = () => {
      const reader = iterator();
      return { next() { if (++reads === 4) waiting.resolve(); return reader.next(); }, return: () => reader.return() };
    };
    streams.push(stream); return stream;
  };
  const transfer = transferMedia({ ...f, request, idleTimeoutMs: 20 });
  await waiting.promise; t.mock.timers.tick(20);
  assert.equal((await transfer).sha256, hash(payload)); assert.equal(full, 2);
});
