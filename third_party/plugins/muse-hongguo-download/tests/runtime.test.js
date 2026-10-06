/** Managed-process fixtures cover private stdin, complete decoding and cancellation quiescence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createDeviceBootstrap, createMediaProcessor } from '../src/runtime.js';

const config = () => ({ legacyAppDir: join(tmpdir(), 'source-app'), pythonExecutable: join(tmpdir(), 'runtime', 'python'),
  ffmpegExecutable: join(tmpdir(), 'runtime', 'ffmpeg'), ffprobeExecutable: join(tmpdir(), 'runtime', 'ffprobe'),
  downloadTimeoutMs: 600000, maxEpisodeBytes: 1024 ** 3, mediaProcessGraceMs: 1000, deviceBootstrapTimeoutMs: 30000 });
const paths = () => ({ inputPath: join(tmpdir(), 'owned-staging', 'episode.part'), outputPath: join(tmpdir(), 'owned-staging', 'episode.decoded.part'),
  workspace: join(tmpdir(), 'owned-staging'), signal: new AbortController().signal });
const probe = overrides => JSON.stringify({ format: { duration: '12.34' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 720, height: 1280 }], ...overrides });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(outputs, settings = config(), processor = createMediaProcessor) {
  const calls = [], resolutions = [], exits = [];
  const subprocess = {
    async resolveExecutable(value, _env, signal) { signal.throwIfAborted(); resolutions.push(value); return value; },
    spawn(spec) {
      calls.push(spec);
      const entry = outputs[calls.length - 1];
      assert.ok(entry, 'test fixture must own each process');
      const reader = stream => ({ readFrom(offset) { assert.equal(offset, 0); return { text: entry[stream] ?? '', lossy: false, ...entry[`${stream}Read`] }; } });
      return { collected: { stdout: reader('stdout'), stderr: reader('stderr') },
        done: entry.done ?? Promise.resolve({ exitCode: entry.exitCode ?? 0, signal: entry.signal ?? null }),
        terminate() { entry.terminate?.(); },
        async waitForExit(signal) { exits.push(calls.length); return entry.waitForExit ? entry.waitForExit(signal) : true; } };
    },
  };
  return { process: processor(subprocess, settings), subprocess, calls, resolutions, exits, settings };
}

test('archived plugin passes its unpacked bridge to external Python', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-hongguo-asar-')));
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    const source = join(root, 'app.asar', 'node_modules', 'muse-hongguo-download', 'src');
    const python = join(root, 'app.asar.unpacked', 'node_modules', 'muse-hongguo-download', 'python');
    await mkdir(source, { recursive: true });
    await mkdir(python, { recursive: true });
    for (const file of ['runtime.js', 'errors.js']) await copyFile(new URL('../src/' + file, import.meta.url), join(source, file));
    await writeFile(join(python, 'decrypt.py'), 'print("native bridge")\n');
    const plugin = await import(pathToFileURL(join(source, 'runtime.js')).href);
    const f = fixture([{ stdout: '{"ok":true}' }, { stdout: probe() }, {}], config(), plugin.createMediaProcessor);
    await f.process({ encryption: { spade: 'PRIVATE' } }, paths());
    assert.equal(f.calls[0].argv[3], join(python, 'decrypt.py'));
    assert.equal(await readFile(f.calls[0].argv[3], 'utf8'), 'print("native bridge")\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('plaintext requires only media executables and validates every video and audio stream', async () => {
  const f = fixture([{ stdout: probe() }, {}], { ...config(), pythonExecutable: '', legacyAppDir: '' });
  const local = paths();
  const result = await f.process({ encryption: null }, local);
  assert.deepEqual(result, { processedPath: local.inputPath, durationSeconds: 12.34, fullDecodeChecked: true, validationLevel: 'ffprobe-full-decode-sha256' });
  assert.deepEqual(f.resolutions, [f.settings.ffprobeExecutable, f.settings.ffmpegExecutable]);
  assert.equal(f.calls.length, 2); assert.equal(f.exits.length, 2);
  for (const call of f.calls) {
    assert.equal(call.cwd, local.workspace); assert.equal(call.stdio.stdin, 'ignore');
    assert.deepEqual(call.stdio.stdout, { maxBytes: 65536 }); assert.deepEqual(call.stdio.stderr, { maxBytes: 65536 });
    assert.equal(call.argv[call.argv.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    assert.equal(call.argv[call.argv.indexOf('-i') + 1], local.inputPath);
    assert.equal(call.graceMs, f.settings.mediaProcessGraceMs);
  }
  assert.ok(f.calls[1].argv.includes('-xerror')); assert.ok(f.calls[1].argv.includes('explode'));
  assert.ok(f.calls[1].argv.includes('0:v?')); assert.ok(f.calls[1].argv.includes('0:a?'));
});

test('encrypted processing keeps private spade in stdin and validates only the decrypted file', async () => {
  const f = fixture([{ stdout: JSON.stringify({ ok: true, code: 'OK' }) }, { stdout: probe() }, {}]);
  const local = paths(), spade = 'PRIVATE_SPADE_VALUE';
  const result = await f.process({ encryption: { spade } }, local);
  assert.equal(result.processedPath, local.outputPath);
  assert.deepEqual(f.calls[0].argv.slice(0, 3), [f.settings.pythonExecutable, '-I', '-B']);
  assert.ok(f.calls[0].argv[3].endsWith('decrypt.py'));
  assert.deepEqual(JSON.parse(f.calls[0].stdio.stdin.data), { appDir: f.settings.legacyAppDir, spade,
    input: local.inputPath, output: local.outputPath, ffmpeg: f.settings.ffmpegExecutable });
  assert.equal(JSON.stringify(f.calls.map(({ stdio, ...publicSpec }) => publicSpec)).includes(spade), false);
  assert.equal(JSON.stringify(result).includes(spade), false);
  assert.ok(f.calls.slice(1).every(call => call.argv[call.argv.indexOf('-i') + 1] === local.outputPath));
});

test('all required explicit settings and executable lookups succeed before the first process', async () => {
  for (const field of ['ffprobeExecutable', 'ffmpegExecutable', 'pythonExecutable', 'legacyAppDir']) {
    const f = fixture([], { ...config(), [field]: '' });
    await assert.rejects(f.process({ encryption: { spade: 'PRIVATE' } }, paths()), error => error.code === 'missing_media_runtime');
    assert.equal(f.calls.length, 0); assert.equal(f.resolutions.length, 0);
  }
  const f = fixture([]);
  f.subprocess.resolveExecutable = async value => { f.resolutions.push(value); if (value === f.settings.ffmpegExecutable) throw new Error('PRIVATE_EXECUTABLE_PATH'); return value; };
  await assert.rejects(f.process({ encryption: null }, paths()), error => error.code === 'missing_media_runtime' && !error.message.includes('PRIVATE'));
  assert.equal(f.resolutions.length, 2); assert.equal(f.calls.length, 0);
});

test('bad decryption output or diagnostics fail safely before media probing', async () => {
  for (const output of [
    { stdout: '{PRIVATE' }, { stdout: 'null' }, { stdout: '{"ok":false,"message":"PRIVATE"}' },
    { stdout: '{"ok":true}', exitCode: 1 }, { stdout: '{"ok":true}', signal: 'SIGTERM' },
    { stdout: '{"ok":true}', stderr: 'PRIVATE_ERROR' }, { stdout: '{"ok":true}', stdoutRead: { lossy: true } },
    { stdout: '{"ok":true}', stderrRead: { lossy: true } }, { stdout: ' '.repeat(65537) },
  ]) {
    const f = fixture([output]);
    await assert.rejects(f.process({ encryption: { spade: 'PRIVATE_SPADE' } }, paths()), error => error.code === 'decryption_failed' && !error.message.includes('PRIVATE'));
    assert.equal(f.calls.length, 1);
  }
});

test('probing rejects incomplete output, invalid duration and missing real video dimensions', async () => {
  for (const output of [
    { stdout: '{PRIVATE' }, { stdout: '[]' }, { stdout: probe({ format: { duration: 'Infinity' } }) },
    { stdout: probe({ format: { duration: true } }) }, { stdout: probe({ format: { duration: '0' } }) },
    { stdout: probe({ streams: [{ codec_type: 'audio', codec_name: 'aac' }] }) },
    { stdout: probe({ streams: [{ codec_type: 'video', codec_name: 'unknown', width: 720, height: 1280 }] }) },
    { stdout: probe({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 0, height: 1280 }] }) },
    { stdout: probe(), exitCode: 1 }, { stdout: probe(), stderr: 'PRIVATE_DECODER_ERROR' },
    { stdout: probe(), stdoutRead: { lossy: true } }, { stdout: probe(), stderrRead: { lossy: true } },
  ]) {
    const f = fixture([output]);
    await assert.rejects(f.process({ encryption: null }, paths()), error => error.code === 'invalid_media' && !error.message.includes('PRIVATE'));
    assert.equal(f.calls.length, 1);
  }
});

test('full decoding requires a clean exit and complete empty diagnostics', async () => {
  for (const output of [{ exitCode: 1 }, { signal: 'SIGKILL' }, { stderr: 'PRIVATE_CORRUPT_PACKET' }, { stdout: 'PRIVATE_UNEXPECTED_OUTPUT' },
    { stderrRead: { lossy: true } }, { stdoutRead: { truncated: true } }]) {
    const f = fixture([{ stdout: probe() }, output]);
    await assert.rejects(f.process({ encryption: null }, paths()), error => error.code === 'decode_failed' && !error.message.includes('PRIVATE'));
    assert.equal(f.calls.length, 2);
  }
});

test('spawn and provider failures expose only fixed diagnostics', async () => {
  const f = fixture([]);
  f.subprocess.spawn = () => { throw new Error('PRIVATE_SPAWN_PATH'); };
  await assert.rejects(f.process({ encryption: null }, paths()), error => error.code === 'invalid_media' && !error.message.includes('PRIVATE'));
  const g = fixture([{ stdout: probe(), done: Promise.reject(new Error('PRIVATE_PROVIDER_ERROR')) }]);
  await assert.rejects(g.process({ encryption: null }, paths()), error => error.code === 'invalid_media' && !error.message.includes('PRIVATE'));
  assert.equal(g.exits.length, 1);
});

test('caller cancellation waits for process exit and managed descendants before rejecting', async () => {
  const started = deferred(), done = deferred(), range = deferred(), controller = new AbortController();
  const f = fixture([{ stdout: probe(), done: done.promise, waitForExit: () => range.promise }]);
  const spawn = f.subprocess.spawn.bind(f.subprocess);
  f.subprocess.spawn = spec => { const handle = spawn(spec); started.resolve(spec); return handle; };
  const work = f.process({ encryption: null }, { ...paths(), signal: controller.signal });
  let settled = false; void work.then(() => { settled = true; }, () => { settled = true; });
  const spec = await started.promise;
  controller.abort(new Error('PRIVATE_CANCEL_REASON'));
  assert.equal(spec.signal.aborted, true); assert.equal(settled, false);
  done.resolve({ exitCode: 0, signal: null });
  await Promise.resolve(); assert.equal(settled, false);
  range.resolve(true);
  await assert.rejects(work, error => error.code === 'cancelled' && !error.message.includes('PRIVATE'));
  assert.equal(f.calls.length, 1);
});

test('pre-cancelled work performs neither executable lookup nor spawn', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture([]);
  await assert.rejects(f.process({ encryption: null }, { ...paths(), signal: controller.signal }), error => error.code === 'cancelled');
  assert.deepEqual(f.resolutions, []); assert.deepEqual(f.calls, []);
});

test('cancellation during descendant observation terminates the range and awaits its unbounded exit', async () => {
  const observing = deferred(), terminated = deferred(), range = deferred(), controller = new AbortController();
  const f = fixture([{ stdout: probe(), terminate: () => terminated.resolve(), waitForExit(signal) {
    if (!signal) return range.promise;
    observing.resolve();
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }));
  } }]);
  const work = f.process({ encryption: null }, { ...paths(), signal: controller.signal });
  let settled = false; void work.then(() => { settled = true; }, () => { settled = true; });
  await observing.promise; controller.abort(); await terminated.promise;
  assert.equal(settled, false);
  range.resolve(true);
  await assert.rejects(work, error => error.code === 'cancelled');
  assert.equal(f.calls.length, 1);
});

test('deadline cancellation waits for the managed process completion even after exit zero', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred(), done = deferred(), range = deferred();
  const f = fixture([{ stdout: probe(), done: done.promise, waitForExit: () => range.promise }], { ...config(), downloadTimeoutMs: 100 });
  const spawn = f.subprocess.spawn.bind(f.subprocess);
  f.subprocess.spawn = spec => { const handle = spawn(spec); started.resolve(spec); return handle; };
  const work = f.process({ encryption: null }, paths());
  const spec = await started.promise;
  t.mock.timers.tick(100);
  assert.equal(spec.signal.aborted, true);
  done.resolve({ exitCode: 0, signal: null }); range.resolve(true);
  await assert.rejects(work, error => error.code === 'cancelled');
  assert.equal(f.calls.length, 1);
});

test('device bootstrap safely rejects missing runtime inputs without leaving an unhandled startup', async t => {
  for (const missing of ['subprocess', 'pythonExecutable', 'legacyAppDir']) {
    await t.test(missing, async () => {
      const f = fixture([]);
      const settings = { ...config(), ...(missing === 'subprocess' ? {} : { [missing]: '' }) };
      const bootstrap = createDeviceBootstrap(missing === 'subprocess' ? undefined : f.subprocess, settings);
      try {
        await assert.rejects(bootstrap.ensure(new AbortController().signal), error =>
          error.code === 'invalid_original_source' && error.message === '本机原源设备初始化失败；请检查内置 Python 3.11 和原设备生成模块');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(f.calls, []);
        assert.deepEqual(f.resolutions, []);
      } finally { await bootstrap.dispose(); }
    });
  }
});

test('original device bootstrap owns one successful Python execution and retains its readiness', async () => {
  const f = fixture([{ stdout: '{"ok":true,"code":"OK"}' }], config(), createDeviceBootstrap);
  try {
    assert.equal(f.calls.length, 0);
    await f.process.ensure(new AbortController().signal);
    await f.process.ensure(new AbortController().signal);
    assert.equal(f.calls.length, 1);
    const spec = f.calls[0];
    assert.deepEqual(spec.argv.slice(0, 3), [f.settings.pythonExecutable, '-I', '-B']);
    assert.ok(spec.argv[3].endsWith('bootstrap.py'));
    assert.deepEqual(JSON.parse(spec.stdio.stdin.data), { appDir: f.settings.legacyAppDir });
    assert.equal(spec.cwd, f.settings.legacyAppDir);
    assert.equal(spec.graceMs, f.settings.mediaProcessGraceMs);
    assert.deepEqual(f.exits, [1]);
  } finally { await f.process.dispose(); }
  await assert.rejects(f.process.ensure(new AbortController().signal), error => error.code === 'cancelled');
});

test('device bootstrap shares first use and one cancelled caller preserves another initializer wait', async () => {
  const started = deferred(), done = deferred(), range = deferred(), controller = new AbortController();
  const f = fixture([{ stdout: '{"ok":true,"code":"OK"}', done: done.promise, waitForExit: () => range.promise }], config(), createDeviceBootstrap);
  const spawn = f.subprocess.spawn.bind(f.subprocess);
  f.subprocess.spawn = spec => { const handle = spawn(spec); started.resolve(spec); return handle; };
  try {
    const first = f.process.ensure(controller.signal), second = f.process.ensure(new AbortController().signal);
    const spec = await started.promise;
    controller.abort();
    await assert.rejects(first, error => error.code === 'cancelled');
    assert.equal(spec.signal.aborted, false); assert.equal(f.calls.length, 1);
    done.resolve({ exitCode: 0, signal: null }); range.resolve(true);
    await second;
  } finally { done.resolve({ exitCode: 0, signal: null }); range.resolve(true); await f.process.dispose(); }
});

test('device bootstrap sole caller cancellation waits for Python and its managed descendants', async () => {
  const started = deferred(), terminated = deferred(), done = deferred(), range = deferred(), controller = new AbortController();
  const f = fixture([{ stdout: '{"ok":true,"code":"OK"}', done: done.promise, terminate: () => terminated.resolve(),
    waitForExit(signal) {
      if (!signal) return range.promise;
      if (signal.aborted) return false;
      return Promise.race([range.promise, new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }))]);
    } }], config(), createDeviceBootstrap);
  const spawn = f.subprocess.spawn.bind(f.subprocess);
  f.subprocess.spawn = spec => { const handle = spawn(spec); started.resolve(spec); return handle; };
  const work = f.process.ensure(controller.signal);
  let settled = false; void work.then(() => { settled = true; }, () => { settled = true; });
  try {
    const spec = await started.promise;
    controller.abort(new Error('PRIVATE_CANCEL_REASON'));
    assert.equal(spec.signal.aborted, false);
    // The last waiter owns cancellation of the shared initialization process.
    done.resolve({ exitCode: 0, signal: null });
    await terminated.promise;
    assert.equal(spec.signal.aborted, true); assert.equal(settled, false);
    range.resolve(true);
    await assert.rejects(work, error => error.code === 'cancelled' && !error.message.includes('PRIVATE'));
  } finally { done.resolve({ exitCode: 0, signal: null }); range.resolve(true); await f.process.dispose(); }
});

test('device initialization rejects incomplete output, failure codes and diagnostic leakage', async () => {
  for (const output of [{ stdout: '{"ok":false,"code":"DEVICES_INVALID"}' }, { stdout: '{PRIVATE' }, { stdout: 'null' },
    { stdout: '{"ok":true}', exitCode: 1 }, { stdout: '{"ok":true}', signal: 'SIGTERM' },
    { stdout: '{"ok":true}', stderr: 'PRIVATE_SOURCE' }, { stdout: '{"ok":true}', stdoutRead: { lossy: true } }]) {
    const f = fixture([output], config(), createDeviceBootstrap);
    try { await assert.rejects(f.process.ensure(new AbortController().signal), error => error.code === 'invalid_original_source' && !error.message.includes('PRIVATE')); }
    finally { await f.process.dispose(); }
    assert.equal(f.calls.length, 1);
  }
});

test('device bootstrap disposal aborts startup and waits for complete child cleanup', async () => {
  const started = deferred(), done = deferred(), range = deferred();
  const f = fixture([{ stdout: '{"ok":true,"code":"OK"}', done: done.promise, waitForExit: () => range.promise }], config(), createDeviceBootstrap);
  const spawn = f.subprocess.spawn.bind(f.subprocess);
  f.subprocess.spawn = spec => { const handle = spawn(spec); started.resolve(spec); return handle; };
  const work = f.process.ensure(new AbortController().signal);
  void work.catch(() => {});
  const spec = await started.promise;
  const disposing = f.process.dispose();
  let settled = false; void disposing.then(() => { settled = true; });
  assert.equal(spec.signal.aborted, true); assert.equal(settled, false);
  done.resolve({ exitCode: 0, signal: null });
  await Promise.resolve(); assert.equal(settled, false);
  range.resolve(true);
  await disposing;
  await assert.rejects(work, error => error.code === 'cancelled');
});
