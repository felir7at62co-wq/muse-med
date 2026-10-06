/** Signer startup fixtures own temp roots, process completion and cancellation barriers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { LocalSigner } from '../src/signer.js';
import { HongguoDownloadClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const liveSignal = () => new AbortController().signal;
const readyOutput = port => `[*] unidbg 离线签名服务已启动: 127.0.0.1:${port}/sign (auth on, Ctrl-C 停止)\n[*] 番茄海外 init 完成 base=0x12000000\n`;
const reply = value => Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), { statusCode: 200, headers: {} });

async function fixture(t, values = {}) {
  const app = await mkdtemp(join(tmpdir(), 'muse-signer-source-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  for (const name of ['sign/unidbg-sign.jar', 'capture/fq_oversea/libmetasec_ml.so', 'capture/fq_oversea/ms_16777218.bin']) {
    await mkdir(dirname(join(app, name)), { recursive: true });
    await writeFile(join(app, name), `ORIGINAL_FIXTURE_${name}\n`);
  }
  await writeFile(join(app, 'config.json'), JSON.stringify({ api_host: 'api.example.org', base_query: { app: 1 }, session_headers: {} }));
  await writeFile(join(app, 'devices.json'), '[{"query":{"device_id":"PRIVATE_DEVICE"},"user_agent":"fixture"}]');
  const config = resolveConfig({ legacyAppDir: app, javaExecutable: join(app, 'java'), signerPollIntervalMs: 1, ...values });
  const calls = [], started = deferred(), terminated = deferred(), done = deferred(), range = deferred();
  let output = '', errorOutput = '';
  const subprocess = {
    async resolveExecutable(value, _env, signal) { signal.throwIfAborted(); return value; },
    spawn(spec) {
      calls.push(spec); started.resolve(spec);
      return { collected: {
        stdout: { readFrom() { return { text: output, nextOffset: Buffer.byteLength(output), lossy: false }; } },
        stderr: { readFrom() { return { text: errorOutput, nextOffset: Buffer.byteLength(errorOutput), lossy: false }; } },
      }, done: done.promise, terminate() { terminated.resolve(); }, waitForExit() { return range.promise; } };
    },
  };
  const signer = new LocalSigner(subprocess, config, { port: () => 54321 });
  t.after(async () => { done.resolve({ exitCode: 0, signal: null }); range.resolve(true); await signer.dispose(); });
  return { app, config, subprocess, signer, calls, started, terminated, done, range,
    ready(port = 54321) { output = readyOutput(port); }, output(value) { output = value; }, stderr(value) { errorOutput = value; } };
}

test('validated signer settings fail before process allocation and construction stays lazy', async t => {
  for (const value of [{ javaExecutable: 'relative/java' }, { signerStartupTimeoutMs: 0 }, { signerHeapMb: 128 },
    { signerPollIntervalMs: 0 }, { signerPortAttempts: 17 }, { signerHeapMb: 1024.5 }, { bootstrapDevices: 'true' },
    { deviceBootstrapTimeoutMs: 0 }]) assert.throws(() => resolveConfig(value), TypeError);
  const f = await fixture(t);
  assert.equal(f.calls.length, 0);
  await f.signer.dispose();
  assert.equal(f.calls.length, 0);
});

test('owned startup copies only signer assets and keeps its token private to the child and signer request', async t => {
  const f = await fixture(t), before = process.env.MUSE_HONGGUO_SIGN_TOKEN;
  const work = f.signer.ensure(liveSignal());
  const spec = await f.started.promise;
  const root = dirname(spec.cwd);
  assert.deepEqual(await readdir(root), ['capture', 'sign']);
  assert.deepEqual(await readdir(spec.cwd), ['unidbg-sign.jar']);
  assert.deepEqual(await readdir(join(root, 'capture', 'fq_oversea')), ['libmetasec_ml.so', 'ms_16777218.bin']);
  assert.equal(await readFile(join(spec.cwd, 'unidbg-sign.jar'), 'utf8'), 'ORIGINAL_FIXTURE_sign/unidbg-sign.jar\n');
  if (process.platform !== 'win32') {
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(spec.cwd, 'unidbg-sign.jar'))).mode & 0o777, 0o600);
  }
  assert.equal(spec.env.BIND_HOST, '127.0.0.1');
  assert.match(spec.env.HG_SIGN_TOKEN, /^[\da-f]{64}$/);
  assert.equal(process.env.MUSE_HONGGUO_SIGN_TOKEN, before);
  assert.equal(spec.argv.includes(spec.env.HG_SIGN_TOKEN), false);
  assert.equal(spec.env.JAVA_TOOL_OPTIONS, undefined);
  assert.equal(spec.argv.at(-1), '54321');
  assert.ok(spec.argv.includes('-Xmx1024m'));
  assert.deepEqual(spec.stdio, { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } });
  f.ready();
  const endpoint = await work;
  assert.deepEqual(endpoint, { url: 'http://127.0.0.1:54321/sign', token: spec.env.HG_SIGN_TOKEN });
  assert.equal(await f.signer.ensure(liveSignal()), endpoint);
  f.done.resolve({ exitCode: 0, signal: null }); f.range.resolve(true);
  await f.signer.dispose();
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});

test('concurrent first calls share startup and one cancelled caller preserves the other caller', async t => {
  const f = await fixture(t), cancelled = new AbortController();
  const first = f.signer.ensure(cancelled.signal), second = f.signer.ensure(liveSignal());
  await f.started.promise;
  cancelled.abort();
  await assert.rejects(first, error => error.code === 'cancelled');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, false);
  f.ready();
  assert.equal((await second).url, 'http://127.0.0.1:54321/sign');
});

test('sole caller cancellation waits for child outcome and managed range cleanup', async t => {
  const f = await fixture(t), controller = new AbortController();
  const work = f.signer.ensure(controller.signal);
  let settled = false; void work.then(() => { settled = true; }, () => { settled = true; });
  const spec = await f.started.promise;
  controller.abort(new Error('PRIVATE_CALLER_REASON'));
  await f.terminated.promise;
  assert.equal(spec.signal.aborted, true); assert.equal(settled, false);
  f.done.resolve({ exitCode: 0, signal: null });
  await Promise.resolve(); assert.equal(settled, false);
  f.range.resolve(true);
  await assert.rejects(work, error => error.code === 'cancelled' && !error.message.includes('PRIVATE'));
  await assert.rejects(lstat(dirname(spec.cwd)), { code: 'ENOENT' });
});

test('dispose waits for a startup child and refuses later startup', async t => {
  const f = await fixture(t);
  const work = f.signer.ensure(liveSignal());
  void work.catch(() => {});
  const spec = await f.started.promise;
  const disposing = f.signer.dispose();
  let settled = false; void disposing.then(() => { settled = true; });
  await f.terminated.promise;
  assert.equal(settled, false);
  f.done.resolve({ exitCode: 0, signal: null }); f.range.resolve(true);
  await disposing;
  await assert.rejects(work, error => error.code === 'cancelled');
  await assert.rejects(lstat(dirname(spec.cwd)), { code: 'ENOENT' });
  await assert.rejects(f.signer.ensure(liveSignal()), error => error.code === 'cancelled');
});

test('startup deadline reaps a child even when it later exits zero', async t => {
  const f = await fixture(t, { signerStartupTimeoutMs: 100, signerPollIntervalMs: 1000 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const work = f.signer.ensure(liveSignal());
  void work.catch(() => {});
  const spec = await f.started.promise;
  t.mock.timers.tick(100);
  await f.terminated.promise;
  assert.equal(spec.signal.aborted, true);
  f.done.resolve({ exitCode: 0, signal: null }); f.range.resolve(true);
  await assert.rejects(work, error => error.code === 'signer_start_timeout');
  await assert.rejects(lstat(dirname(spec.cwd)), { code: 'ENOENT' });
});

test('readiness refuses another port, missing auth and unfinished original engine initialization', async t => {
  for (const output of [readyOutput(54322), readyOutput(54321).replace('auth on', 'auth off'),
    '[*] unidbg 离线签名服务已启动: 127.0.0.1:54321/sign (auth on, Ctrl-C 停止)\n']) {
    const f = await fixture(t), controller = new AbortController();
    f.output(output);
    const work = f.signer.ensure(controller.signal);
    void work.catch(() => {});
    await f.started.promise;
    assert.equal(f.signer.state.ready, null);
    controller.abort(); f.done.resolve({ exitCode: 1, signal: null }); f.range.resolve(true);
    await assert.rejects(work, error => error.code === 'cancelled');
  }
});

test('missing assets or failed Java lookup produce fixed safe failures without spawning', async t => {
  for (const mode of ['asset', 'lookup']) {
    const f = await fixture(t);
    if (mode === 'asset') await rm(join(f.app, 'capture', 'fq_oversea', 'ms_16777218.bin'));
    else f.subprocess.resolveExecutable = async () => { throw new Error('PRIVATE_JAVA_PATH'); };
    await assert.rejects(f.signer.ensure(liveSignal()), error => error.code === 'missing_original_signer' && !error.message.includes('PRIVATE'));
    assert.equal(f.calls.length, 0);
  }
});

test('unexpected child exit fails safely and releases its private directory', async t => {
  const f = await fixture(t);
  f.stderr('PRIVATE_SOURCE_DIAGNOSTIC');
  const work = f.signer.ensure(liveSignal());
  const spec = await f.started.promise;
  f.done.resolve({ exitCode: 1, signal: null }); f.range.resolve(true);
  await assert.rejects(work, error => error.code === 'missing_original_signer' && !error.message.includes('PRIVATE'));
  await assert.rejects(lstat(dirname(spec.cwd)), { code: 'ENOENT' });
});

test('only an original Java bind conflict retries another random port within the configured budget', async t => {
  const f = await fixture(t, { signerPortAttempts: 2 }), second = deferred();
  let nextPort = 54320;
  f.signer.port = () => ++nextPort;
  const spawn = f.subprocess.spawn.bind(f.subprocess);
  f.subprocess.spawn = spec => {
    const handle = spawn(spec);
    if (f.calls.length === 1) return { ...handle,
      collected: { ...handle.collected, stderr: { readFrom() { return { text: 'java.net.BindException: Address already in use', lossy: false }; } } },
      done: Promise.resolve({ exitCode: 1, signal: null }), waitForExit: async () => true };
    second.resolve(spec);
    return handle;
  };
  const work = f.signer.ensure(liveSignal());
  await second.promise;
  f.ready(54322);
  assert.equal((await work).url, 'http://127.0.0.1:54322/sign');
  assert.deepEqual(f.calls.map(spec => spec.argv.at(-1)), ['54321', '54322']);
  assert.equal(f.calls[0].cwd, f.calls[1].cwd);
});

test('a stopped signer refuses later requests and independently owned instances use distinct tokens and directories', async t => {
  const first = await fixture(t), second = await fixture(t);
  const works = [first.signer.ensure(liveSignal()), second.signer.ensure(liveSignal())];
  const specs = await Promise.all([first.started.promise, second.started.promise]);
  assert.notEqual(specs[0].cwd, specs[1].cwd);
  assert.notEqual(specs[0].env.HG_SIGN_TOKEN, specs[1].env.HG_SIGN_TOKEN);
  first.ready(); second.ready();
  await Promise.all(works);
  first.done.resolve({ exitCode: 0, signal: null }); first.range.resolve(true);
  await first.done.promise;
  await assert.rejects(first.signer.ensure(liveSignal()), error => error.code === 'signer_stopped');
  assert.equal(second.calls[0].signal.aborted, false);
});

test('catalog composition starts its owned signer lazily and returns no token or device fields', async t => {
  const f = await fixture(t), signCalls = [];
  const client = new HongguoDownloadClient(f.config, { subprocess: f.subprocess,
    async sign(url, _payload, token) { signCalls.push({ url, token }); return reply({}); },
    async request() { return reply({ code: 0, data: { '123': { video_data: { series_id: '123', series_title: 'fixture', episode_cnt: 1,
      video_list: [{ vid_index: 1, vid: 'fixture', duration: 12 }] } } } }); },
  });
  t.after(() => client.dispose());
  assert.equal(f.calls.length, 0);
  const work = client.info({ seriesIds: ['123'] });
  const spec = await f.started.promise;
  f.ready(Number(spec.argv.at(-1)));
  const result = await work;
  assert.equal(result.ok, true); assert.equal(result.items[0].episodeCount, 1);
  assert.equal(signCalls.length, 1);
  assert.equal(signCalls[0].token, spec.env.HG_SIGN_TOKEN);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DEVICE/);
  assert.equal(JSON.stringify(result).includes(spec.env.HG_SIGN_TOKEN), false);
  f.done.resolve({ exitCode: 0, signal: null }); f.range.resolve(true);
  await client.dispose();
  await assert.rejects(lstat(dirname(spec.cwd)), { code: 'ENOENT' });
});
