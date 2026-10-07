/** Exercise tool scope, credential selection, process settlement, and receipts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, validateArgs } from '../src/index.js';
import { downloadCommand, resolveConfig, runDownloader } from '../src/runner.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspace = join(tmpdir(), 'douyin-parser-workspace');
const settings = resolveConfig({ settingsHome: join(tmpdir(), 'muse-own-settings'), pythonExecutable: 'fixture-python', ffprobeExecutable: 'fixture-probe', ffmpegExecutable: 'fixture-decoder' });
const receipt = { status: 'downloaded', full_decode_verified: true,
  source: 'https://www.douyin.com/video/7691637134771391771',
  path: join(workspace, 'source/media/douyin/7691637134771391771.mp4'),
  receipt: join(workspace, 'source/media/douyin/7691637134771391771.mp4.source.json'),
  bytes: 1024, sha256: 'a'.repeat(64), duration_seconds: 3.5 };
const input = { url: receipt.source, publicOnly: true };

function subprocess(result, outcome = { exitCode: 0, signal: null }) {
  return { spawn() { return { done: Promise.resolve(outcome), collected: { stdout: { readFrom() { return { text: JSON.stringify(result), lossy: false, truncated: false }; } } } }; } };
}

test('deployment config and argv retain explicit workspace and executable paths', () => {
  const config = resolveConfig({ settingsHome: null, pythonExecutable: 'python fixture', ffprobeExecutable: 'probe fixture', ffmpegExecutable: 'decode fixture' });
  const command = downloadCommand(config, input, workspace);
  assert.equal(command[0], 'python fixture');
  assert.ok(command.includes('-I'));
  assert.equal(command[command.indexOf('--project') + 1], workspace);
  assert.equal(command[command.indexOf('--ffmpeg') + 1], 'decode fixture');
  assert.ok(command.includes('--public-only'));
  assert.throws(() => downloadCommand(config, { url: receipt.source }, workspace), /settingsHome/);
  assert.throws(() => resolveConfig({ requestTimeoutMs: 0 }), /requestTimeoutMs/);
  assert.throws(() => resolveConfig({ arbitrary: true }), /Unknown/);
});

test('tool input rejects implicit profiles and multiple authentication sources', () => {
  for (const value of [{ url: input.url, browser: 'chrome' }, { url: input.url, browserProfile: 'Default' },
    { url: input.url, publicOnly: true, cookieFile: '/fixture/cookies.txt' },
    { url: input.url, rememberBrowser: true }, { url: input.url, project: '/outside' }]) assert.throws(() => validateArgs(value));
  assert.equal(validateArgs(input), input);
});

test('verified success requires full decoding and a workspace receipt', async () => {
  assert.deepEqual(await runDownloader(subprocess(receipt), settings, ['python'], workspace), receipt);
});

test('unverified and escaping receipts fail before returning success', async () => {
  for (const change of [{ full_decode_verified: false }, { bytes: 0 }, { path: join(tmpdir(), 'outside.mp4') }]) {
    await assert.rejects(runDownloader(subprocess({ ...receipt, ...change }), settings, ['python'], workspace));
  }
});

test('bounded blocked output stays a blocked result', async () => {
  const result = { status: 'blocked', message: 'PUBLIC_SHARE_MEDIA_UNAVAILABLE: official player exposed no media' };
  assert.deepEqual(await runDownloader(subprocess(result, { exitCode: 1, signal: null }), settings, ['python'], workspace), result);
});

test('cancellation wins over a child reporting exit zero', async () => {
  const controller = new AbortController();
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  const promise = runDownloader({ spawn() { return { done, collected: { stdout: { readFrom() { return { text: JSON.stringify(receipt) }; } } } }; } }, settings, ['python'], workspace, controller.signal);
  controller.abort(new Error('user cancelled'));
  let completed = false;
  promise.finally(() => { completed = true; }).catch(() => {});
  await Promise.resolve();
  assert.equal(completed, false);
  settle({ exitCode: 0, signal: null });
  await assert.rejects(promise, /user cancelled/);
});

test('plugin scope uses the initiating session and unload awaits subprocess exit', async () => {
  const cleanups = [];
  let tool;
  let spec;
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  const ctx = {
    agents: { requireInitiator() { return { session: { header: { cwd: workspace } } }; } },
    tools: { register(definition) { if (definition.name === 'douyin_download') tool = definition; return () => { tool = undefined; }; } },
    subprocess: { spawn(value) { spec = value; return { done, collected: { stdout: { readFrom() { return { text: JSON.stringify(receipt) }; } } } }; } },
    effect(factory) { cleanups.push(factory()); },
  };
  apply(ctx, settings);
  const execute = tool.execute(input, {});
  assert.equal(spec.cwd, workspace);
  assert.equal(spec.argv[spec.argv.indexOf('--project') + 1], workspace);
  const stop = cleanups[0]();
  assert.equal(spec.signal.aborted, true);
  let stopped = false;
  stop.then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  settle({ exitCode: 0, signal: null });
  await assert.rejects(execute, /unloaded/);
  await stop;
  cleanups[1]();
  assert.equal(tool, undefined);
});

test('batch execution downloads distinct works and preserves a middle failure as partial', async () => {
  const urls = [receipt.source, 'https://www.douyin.com/video/7690548660732434410', 'https://www.douyin.com/video/7691377127358441866'];
  const calls = [];
  const cleanups = [];
  let tool;
  const ctx = {
    agents: { requireInitiator() { return { session: { header: { cwd: workspace } } }; } },
    tools: { register(definition) { if (definition.name === 'douyin_download') tool = definition; return () => {}; } },
    subprocess: { spawn(spec) {
      const url = spec.argv[spec.argv.indexOf('--url') + 1];
      calls.push(url);
      const blocked = url === urls[1];
      const path = join(workspace, 'source/media/douyin/' + url.split('/').at(-1) + '.mp4');
      const result = blocked ? { status: 'blocked', message: 'PUBLIC_SHARE_MEDIA_UNAVAILABLE' } : { ...receipt, source: url, path, receipt: path + '.source.json' };
      return { done: Promise.resolve({ exitCode: blocked ? 1 : 0, signal: null }), collected: { stdout: { readFrom() { return { text: JSON.stringify(result) }; } } } };
    } },
    effect(factory) { cleanups.push(factory()); },
  };
  apply(ctx, settings);
  try {
    const result = await tool.execute({ urls, publicOnly: true }, {});
    assert.deepEqual(calls, urls);
    assert.equal(result.status, 'partial');
    assert.equal(result.requested, 3);
    assert.equal(result.downloaded, 2);
    assert.deepEqual(result.items.map(item => [item.index, item.status]), [[1, 'downloaded'], [2, 'blocked'], [3, 'downloaded']]);
    assert.notEqual(result.items[0].path, result.items[2].path);
    assert.equal(result.items[0].full_decode_verified, true);
    assert.equal(result.items[2].full_decode_verified, true);
    assert.throws(() => validateArgs({ url: urls[0], urls }));
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
});

test('missing bundled runtime blocks single and multiple videos before accessing credentials or spawning', async () => {
  const cleanups = [];
  let tool;
  let spawns = 0;
  const ctx = {
    agents: { requireInitiator() { return { session: { header: { cwd: workspace } } }; } },
    tools: { register(definition) { if (definition.name === 'douyin_download') tool = definition; return () => {}; } },
    subprocess: { spawn() { spawns++; throw new Error('No process should start'); } },
    effect(factory) { cleanups.push(factory()); },
  };
  apply(ctx, { pythonExecutable: null, ffprobeExecutable: null, ffmpegExecutable: null });
  try {
    const result = await tool.execute(input, {});
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'RUNTIME_UNAVAILABLE');
    const batch = await tool.execute({ urls: [receipt.source, 'https://www.douyin.com/video/7690548660732434410'], publicOnly: true }, {});
    assert.equal(batch.status, 'blocked');
    assert.equal(batch.requested, 2);
    assert.equal(batch.downloaded, 0);
    assert.deepEqual(batch.items.map(item => item.code), ['RUNTIME_UNAVAILABLE', 'RUNTIME_UNAVAILABLE']);
    assert.equal(spawns, 0);
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
});
test('plugin forwards its file bound and unload waits for the internal-browser operation to settle', async () => {
  const cleanups = []; let tool; let settle; let browserSignal; let browserLimit; let browserTimeout; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const native = new Promise(resolve => { settle = resolve; });
  const ctx = {
    agents: { requireInitiator() { return { session: { header: { cwd: workspace } } }; } },
    tools: { register(definition) { if (definition.name === 'douyin_download') tool = definition; return () => {}; } },
    subprocess: subprocess({ status: 'blocked', message: 'ACCESS_RESTRICTED' }, { exitCode: 1, signal: null }),
    get() { return { version: 4, download(_agent, _url, signal, maxDownloadBytes, nativeTimeoutMs) { browserSignal = signal; browserLimit = maxDownloadBytes; browserTimeout = nativeTimeoutMs; entered(); return native; } }; },
    effect(factory) { cleanups.push(factory()); },
  };
  apply(ctx, settings);
  const operation = tool.execute({ url: input.url }, {});
  await started;
  assert.equal(browserLimit, settings.maxDownloadBytes);
  assert.equal(browserTimeout, settings.nativeTimeoutMs);
  let stopped = false;
  const stop = cleanups[0]().then(() => { stopped = true; });
  assert.equal(browserSignal.aborted, true);
  await Promise.resolve(); assert.equal(stopped, false);
  settle({ status: 'blocked', code: 'CANCELLED' });
  await operation; await stop;
  assert.equal(stopped, true);
  await cleanups[1]();
});

for (const version of [1, 2, 3]) test(`browser acquisition version ${version} is rejected before native IPC`, async () => {
  const cleanups = []; let tool; let nativeCalls = 0;
  const ctx = {
    agents: { requireInitiator() { return { session: { header: { cwd: workspace } } }; } },
    tools: { register(definition) { if (definition.name === 'douyin_download') tool = definition; return () => {}; } },
    subprocess: subprocess({ status: 'blocked', message: 'ACCESS_RESTRICTED' }, { exitCode: 1, signal: null }),
    get() { return { version, download() { nativeCalls++; throw new Error('Old transport must not run'); } }; },
    effect(factory) { cleanups.push(factory()); },
  };
  apply(ctx, settings);
  try {
    const result = await tool.execute({ url: input.url }, {});
    assert.equal(result.code, 'DESKTOP_HOST_REQUIRED');
    assert.equal(result.status, 'blocked');
    assert.equal(nativeCalls, 0);
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
});

test('native download and verification budgets are explicit and independent from the public deadline', () => {
  assert.equal(settings.nativeTimeoutMs, 1800000);
  const configured = resolveConfig({ timeoutMs: 1000, nativeTimeoutMs: 7200000 });
  assert.equal(configured.timeoutMs, 1000);
  assert.equal(configured.nativeTimeoutMs, 7200000);
  for (const nativeTimeoutMs of [999, 7200001, 1000.5, NaN, Infinity, "1800000", null]) assert.throws(() => resolveConfig({ nativeTimeoutMs }), /nativeTimeoutMs/);
  assert.throws(() => resolveConfig({ timeoutMs: 7200000, nativeTimeoutMs: 7200000, maxVideos: 100 }), /timer range/);
});
