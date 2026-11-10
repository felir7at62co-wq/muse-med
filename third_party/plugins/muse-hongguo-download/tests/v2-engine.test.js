/** Fake native pipes exercise protocol ownership without loading a v2 runtime or making requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { V2EngineClient } from '../src/v2-engine.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {}); return { promise, resolve, reject }; };
const spec = { argv: ['/fixture/java', '-cp', '/fixture/lib/*', 'Main'], cwd: '/fixture', env: { PRIVATE: 'not-logged', REMOVED: undefined },
  startupTimeoutMs: 1000, requestTimeoutMs: 500, maxLineBytes: 4096, maxPendingRequests: 4,
  shutdownTimeoutMs: 700, processGraceMs: 100, clientVersion: 'fixture-1' };
const helloResult = { engineVersion: 'fixture-engine', protocol: 2, capabilities: ['app.ping'], build: 15 };
const ready = { jsonrpc: '2.0', method: 'engine.ready', params: { engineVersion: helloResult.engineVersion, protocol: 2 } };
const safeError = code => error => error.code === code && !error.message.includes('PRIVATE') && error.cause === undefined;

function fixture(t, options = {}) {
  const stdout = new PassThrough(), stderr = new PassThrough(), done = deferred(), range = deferred(), spawned = deferred(), terminated = deferred();
  const writes = [], waiters = [], spawns = [], callbacks = [];
  let finished = false;
  const f = { stdout, stderr, writes, spawns, done, range, spawned, terminated, terminateCount: 0, waitCount: 0, autoShutdown: true,
    send(value) { stdout.write(Buffer.from(JSON.stringify(value) + '\n')); },
    reply(request, result) { f.send({ jsonrpc: '2.0', id: request.id, result }); },
    next(method, after = 0) {
      const existing = writes.slice(after).find(value => value.method === method);
      if (existing) return Promise.resolve(existing);
      const value = deferred(); waiters.push({ method, after, ...value }); return value.promise;
    },
    finish(outcome = { exitCode: 0, signal: null }) {
      if (finished) return; finished = true;
      stdout.end(); stderr.end(); done.resolve(outcome); range.resolve(true);
    },
  };
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const value = JSON.parse(chunk.toString('utf8')); writes.push(value);
    for (const waiter of waiters) if (value.method === waiter.method && writes.length > waiter.after) waiter.resolve(value);
    if (options.holdWrites) callbacks.push(callback); else callback(options.writeFailure ? new Error('PRIVATE_WRITE') : undefined);
    if (value.method === 'app.shutdown' && f.autoShutdown) { f.reply(value, {}); f.finish(); }
  } });
  f.stdin = stdin; f.callbacks = callbacks;
  const subprocess = { spawn(value) {
    if (options.spawnFailure) throw Object.assign(new Error('PRIVATE_SPAWN'), { code: 'v2_io' });
    spawns.push(value); spawned.resolve(value);
    return { stdin, stdout, stderr, done: done.promise,
      terminate() { f.terminateCount++; terminated.resolve(); if (options.terminateFailure) throw new Error('PRIVATE_TERMINATE'); if (!options.manualExit) f.finish(); },
      async waitForExit(signal) {
        f.waitCount++;
        if (!signal) return range.promise;
        if (signal.aborted) return false;
        const aborted = deferred(), abort = () => aborted.resolve(false);
        signal.addEventListener('abort', abort, { once: true });
        try { return await Promise.race([range.promise, aborted.promise]); }
        finally { signal.removeEventListener('abort', abort); }
      },
    };
  } };
  f.client = new V2EngineClient(subprocess, { ...spec, ...options.spec }, options.onNotification);
  f.start = async () => {
    const starting = f.client.start(); await spawned.promise; f.send(ready);
    const hello = await f.next('app.hello'); f.reply(hello, helloResult); await starting; return hello;
  };
  t.after(async () => {
    f.finish();
    if (options.terminateFailure) await assert.rejects(f.client.dispose(), safeError('v2_shutdown'));
    else await f.client.dispose();
    assert.equal(f.client.pending.size, 0); assert.equal(f.client.writes.size, 0);
    for (const stream of [stdin, stdout, stderr]) {
      assert.equal(stream.listenerCount('error'), 0, 'Owned error handlers must be removed');
      if (stream !== stdin) { assert.equal(stream.listenerCount('data'), 0); assert.equal(stream.listenerCount('end'), 0); assert.equal(stream.listenerCount('close'), 0); }
    }
    stdin.destroy(); stdout.destroy(); stderr.destroy();
  });
  return f;
}

test('all process and budget inputs are explicit and construction does not spawn', async t => {
  for (const key of Object.keys(spec)) {
    const invalid = { ...spec }; delete invalid[key];
    assert.throws(() => new V2EngineClient({}, invalid), TypeError);
  }
  for (const changed of [{ cwd: 'relative' }, { argv: [] }, { env: { VALUE: 1 } }, { requestTimeoutMs: 0 },
    { maxPendingRequests: 1.5 }, { shutdownTimeoutMs: 2_147_483_648 }]) {
    assert.throws(() => new V2EngineClient({}, { ...spec, ...changed }), TypeError);
  }
  const f = fixture(t);
  await assert.rejects(f.client.request('app.ping', {}), safeError('v2_not_ready'));
  assert.equal(f.spawns.length, 0);
  await f.client.dispose(); assert.equal(f.spawns.length, 0);
});

test('ready precedes hello and repeated starts share the exact managed process', async t => {
  const notifications = [], f = fixture(t, { onNotification: (...args) => notifications.push(args) });
  const first = f.client.start(), second = f.client.start();
  const launched = await f.spawned.promise;
  assert.deepEqual(launched, { argv: spec.argv, cwd: spec.cwd, env: spec.env,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: spec.processGraceMs });
  assert.equal(f.writes.length, 0);
  f.send(ready);
  const hello = await f.next('app.hello');
  assert.deepEqual(hello.params, { client: 'Muse', clientVersion: spec.clientVersion, protocol: 2 });
  f.reply(hello, helloResult);
  assert.deepEqual(await first, helloResult); assert.equal(await first, await second);
  assert.equal(await f.client.start(), await first); assert.equal(f.spawns.length, 1);
  assert.deepEqual(notifications, [['engine.ready', ready.params]]);
});

test('split UTF-8, CRLF, a BOM and multiple lines preserve exact correlated values', async t => {
  const notifications = [], f = fixture(t, { onNotification: (...args) => notifications.push(args) });
  await f.start();
  const a = f.client.request('first', {}), b = f.client.request('second', {});
  const first = await f.next('first'), second = await f.next('second');
  const bytes = Buffer.from('\uFEFF \r\n' + JSON.stringify({ jsonrpc: '2.0', id: second.id, result: '剧情中文' }) + '\r\n'
    + JSON.stringify({ jsonrpc: '2.0', method: 'progress', params: { value: '完成' } }) + '\n'
    + JSON.stringify({ jsonrpc: '2.0', id: first.id, result: { order: 1 } }) + '\n');
  for (const byte of bytes) f.stdout.write(Buffer.from([byte]));
  assert.equal(await b, '剧情中文'); assert.deepEqual(await a, { order: 1 });
  assert.deepEqual(notifications.at(-1), ['progress', { value: '完成' }]);
});

test('cancellation sends one notification, removes its listener and ignores the late reply', async t => {
  const f = fixture(t); await f.start();
  const controller = new AbortController();
  const request = f.client.request('cancelled', {}, controller.signal), rejected = assert.rejects(request, safeError('v2_cancelled'));
  const original = await f.next('cancelled'); controller.abort(new Error('PRIVATE_REASON'));
  await rejected;
  const cancel = await f.next('$/cancelRequest'); assert.deepEqual(cancel.params, { id: original.id });
  const next = f.client.request('next', {}), nextCall = await f.next('next');
  f.reply(original, 'must-not-resolve-next'); f.reply(nextCall, 'real-next');
  assert.equal(await next, 'real-next'); assert.equal(f.client.pending.size, 0);
  assert.equal(f.writes.filter(value => value.method === '$/cancelRequest').length, 1);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.client.request('never-sent', {}, aborted.signal), safeError('v2_cancelled'));
  assert.equal(f.writes.some(value => value.method === 'never-sent'), false);
});

test('a request deadline cancels only that request and preserves the usable connection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); await f.start();
  const work = f.client.request('timeout', {}), rejected = assert.rejects(work, safeError('v2_request_timeout'));
  const call = await f.next('timeout'); t.mock.timers.tick(spec.requestTimeoutMs); await rejected;
  assert.deepEqual((await f.next('$/cancelRequest')).params, { id: call.id });
  assert.equal(f.terminateCount, 0);
  const next = f.client.request('alive', {}); f.reply(await f.next('alive'), true); assert.equal(await next, true);
});

test('capacity, oversized requests and circular JSON never leak raw input or send the rejected request', async t => {
  const f = fixture(t, { spec: { maxPendingRequests: 1 } }); await f.start();
  const first = f.client.request('held', {}), call = await f.next('held');
  await assert.rejects(f.client.request('excess', { private: 'PRIVATE' }), safeError('v2_capacity'));
  f.reply(call, 1); await first;
  const circular = {}; circular.self = circular;
  await assert.rejects(f.client.request('circular', circular), safeError('v2_request_json'));
  await assert.rejects(f.client.request('large', 'PRIVATE'.repeat(1000)), safeError('v2_line_size'));
  assert.equal(f.writes.some(value => ['excess', 'circular', 'large'].includes(value.method)), false);
  assert.equal(f.client.pending.size, 0);
});

test('remote error preserves only its numeric code and leaves other requests usable', async t => {
  const f = fixture(t); await f.start();
  const work = f.client.request('refused', {}), rejected = assert.rejects(work, error => safeError('v2_remote_error')(error) && error.rpcCode === 451);
  f.send({ jsonrpc: '2.0', id: (await f.next('refused')).id, error: { code: 451, message: 'PRIVATE_URL_KEY', data: { secret: 'PRIVATE' } } });
  await rejected;
  const next = f.client.request('next', {}); f.reply(await f.next('next'), true); assert.equal(await next, true);
});

for (const [name, output] of [
  ['invalid JSON', Buffer.from('PRIVATE-BROKEN\n')],
  ['non-object JSON', Buffer.from('[]\n')],
  ['missing JSON-RPC version', Buffer.from('{"method":"engine.ready","params":{"protocol":2}}\n')],
  ['invalid UTF-8', Buffer.from([0xff, 10])],
  ['conflicting response fields', Buffer.from('{"jsonrpc":"2.0","id":"1","result":1,"error":{}}\n')],
  ['server request', Buffer.from('{"jsonrpc":"2.0","id":"server","method":"execute"}\n')],
]) {
  test(`${name} fails safely and joins the owned process`, async t => {
    const f = fixture(t); await f.start();
    const work = f.client.request('held', {}), rejected = assert.rejects(work, safeError('v2_protocol'));
    f.stdout.write(output); await rejected; await f.client.dispose();
    assert.equal(f.terminateCount, 1); assert.ok(f.waitCount >= 1);
  });
}

test('one oversized partial line is rejected without waiting for a newline', async t => {
  const f = fixture(t); await f.start();
  const request = f.client.request('held', {}), rejected = assert.rejects(request, safeError('v2_line_size'));
  f.stdout.write(Buffer.alloc(spec.maxLineBytes, 32)); f.stdout.write(Buffer.from('x'));
  await rejected; assert.equal(f.terminateCount, 1);
});

test('ready and hello both require protocol 2 and agreeing version metadata', async t => {
  for (const bad of [
    { ready: { ...ready, params: { engineVersion: 'fixture-engine', protocol: 1 } } },
    { hello: { ...helloResult, protocol: 1 } }, { hello: { ...helloResult, engineVersion: 'different' } },
    { hello: { ...helloResult, capabilities: [1] } }, { hello: { ...helloResult, build: null } },
  ]) {
    const f = fixture(t), work = f.client.start(), rejected = assert.rejects(work, safeError('v2_protocol_version'));
    await f.spawned.promise; f.send(bad.ready ?? ready);
    if (!bad.ready) f.reply(await f.next('app.hello'), bad.hello);
    await rejected; assert.equal(f.terminateCount, 1);
  }
});

test('startup timeout and sole waiter cancellation await process-range cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const cancelled of [false, true]) {
    const f = fixture(t, { manualExit: true }), controller = new AbortController();
    const work = f.client.start(controller.signal), rejected = assert.rejects(work, safeError(cancelled ? 'v2_cancelled' : 'v2_start_timeout'));
    await f.spawned.promise;
    let settled = false; void rejected.then(() => { settled = true; });
    if (cancelled) controller.abort(new Error('PRIVATE')); else t.mock.timers.tick(spec.startupTimeoutMs);
    await f.terminated.promise; assert.equal(settled, false);
    f.finish(); await rejected;
  }
});

test('cancelling one startup waiter does not terminate another waiter', async t => {
  const f = fixture(t), controller = new AbortController();
  const first = f.client.start(controller.signal), rejected = assert.rejects(first, safeError('v2_cancelled'));
  const second = f.client.start(); await f.spawned.promise; controller.abort(); await rejected;
  assert.equal(f.terminateCount, 0); f.send(ready); f.reply(await f.next('app.hello'), helloResult);
  assert.deepEqual(await second, helloResult);
});

test('process exit waits for trailing stdout before settling its last response', async t => {
  const f = fixture(t); await f.start();
  const work = f.client.request('last', {}), call = await f.next('last');
  f.done.resolve({ exitCode: 0, signal: null });
  await Promise.resolve();
  await assert.rejects(f.client.start(), safeError('v2_exit'));
  f.stdout.write(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: 'last-result' })));
  f.stdout.end(); f.stderr.end(); f.range.resolve(true);
  assert.equal(await work, 'last-result');
  await assert.rejects(f.client.request('after-exit', {}), safeError('v2_exit'));
});

test('unexpected exit with inherited open stdout is bounded and fails outstanding requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { spec: { requestTimeoutMs: 2000 } }); await f.start();
  const work = f.client.request('held', {}), rejected = assert.rejects(work, safeError('v2_exit'));
  f.done.resolve({ exitCode: 1, signal: null }); await Promise.resolve();
  t.mock.timers.tick(spec.shutdownTimeoutMs); await rejected;
});

test('notification exceptions and spawn failures use safe fixed diagnostics', async t => {
  const f = fixture(t, { onNotification() { throw new Error('PRIVATE_NOTIFICATION'); } });
  const work = f.client.start(), rejected = assert.rejects(work, safeError('v2_notification'));
  await f.spawned.promise; f.send(ready); await rejected;
  const failed = fixture(t, { spawnFailure: true });
  await assert.rejects(failed.client.start(), safeError('v2_io'));
});

test('pipe errors cannot expose raw diagnostics or leave pending requests', async t => {
  for (const streamName of ['stdin', 'stdout', 'stderr']) {
    const f = fixture(t); await f.start();
    const work = f.client.request('held', {}), rejected = assert.rejects(work, safeError('v2_io'));
    f[streamName].emit('error', new Error('PRIVATE_PIPE')); await rejected;
  }
});

test('dispose sends shutdown then EOF, is idempotent and waits for range exit', async t => {
  const f = fixture(t, { manualExit: true }); await f.start(); f.autoShutdown = false;
  const disposing = f.client.dispose(); assert.equal(f.client.dispose(), disposing);
  const request = await f.next('app.shutdown'); assert.equal(f.stdin.writableEnded, false);
  f.reply(request, {});
  await new Promise(resolve => f.stdin.once('finish', resolve));
  let settled = false; void disposing.then(() => { settled = true; });
  assert.equal(settled, false); assert.equal(f.terminateCount, 0);
  f.finish(); await disposing;
  await assert.rejects(f.client.start(), safeError('v2_closed'));
});

test('unresponsive shutdown is terminated at its own deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); await f.start(); f.autoShutdown = false;
  const disposing = f.client.dispose(); await f.next('app.shutdown');
  t.mock.timers.tick(spec.shutdownTimeoutMs); await disposing;
  assert.equal(f.terminateCount, 1); assert.equal(f.stdin.writableEnded, true);
});

test('dispose settles blocked writes and ignores their later callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { holdWrites: true }); await f.start();
  f.callbacks.shift()();
  const work = f.client.request('held', {}), rejected = assert.rejects(work, safeError('v2_closed'));
  await f.next('held');
  const disposing = f.client.dispose();
  t.mock.timers.tick(spec.shutdownTimeoutMs);
  await rejected; await disposing;
  assert.equal(f.client.writes.size, 0);
  for (const callback of f.callbacks) callback(new Error('PRIVATE_LATE_WRITE'));
  assert.equal(f.client.pending.size, 0);
});

test('write callback failures cannot disclose raw errors during startup', async t => {
  const f = fixture(t, { writeFailure: true }), work = f.client.start();
  const rejected = assert.rejects(work, safeError('v2_io'));
  await f.spawned.promise; f.send(ready); await rejected;
  assert.equal(f.terminateCount, 1);
});

test('a throwing termination operation fails cleanup without waiting forever or claiming exit', async t => {
  const f = fixture(t, { manualExit: true, terminateFailure: true });
  const work = f.client.start(), rejected = assert.rejects(work, safeError('v2_shutdown'));
  await f.spawned.promise; f.stdout.write(Buffer.from('invalid-private-response\n'));
  await rejected;
  assert.equal(f.terminateCount, 1); assert.equal(f.waitCount, 0);
  await assert.rejects(f.client.dispose(), safeError('v2_shutdown'));
});

test('shutdown termination failure stays bounded after the graceful deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { manualExit: true, terminateFailure: true }); await f.start(); f.autoShutdown = false;
  const disposing = f.client.dispose(), rejected = assert.rejects(disposing, safeError('v2_shutdown'));
  await f.next('app.shutdown'); t.mock.timers.tick(spec.shutdownTimeoutMs); await rejected;
  assert.equal(f.terminateCount, 1); assert.equal(f.waitCount, 1);
});
