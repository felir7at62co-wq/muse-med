/** Exercise tool scope, credential selection, process settlement, and receipts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, validateArgs } from '../src/index.js';
import { downloadCommand, resolveConfig, runDownloader } from '../src/runner.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readdir, symlink, unlink } from 'node:fs/promises';
import { taskHarness } from './task-harness.js';
import { mediaReceipt } from './task-fixtures.js';

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

test('a successful child receipt survives cancellation for later actual-file verification', async () => {
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
  assert.deepEqual(await promise, receipt);
});


async function registered(t, options = {}) {
  const h = await taskHarness(t);
  const tools = new Map(), cleanups = [];
  const processCalls = [];
  const processService = options.subprocess ?? { spawn(spec) {
    processCalls.push(spec);
    let output;
    const url = spec.argv[spec.argv.indexOf('--url') + 1];
    return { done: (async () => {
      output = options.result ? await options.result(url, h) : await mediaReceipt(h.owner.agent, url);
      return { exitCode: output.status === 'downloaded' ? 0 : 1, signal: null };
    })(), collected: { stdout: { readFrom: () => ({ text: JSON.stringify(output) }) } } };
  } };
  const context = { agents: h.ctx.agents, subprocess: processService,
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    get(name) { return name === 'douyinBrowser' ? options.browser : h.ctx.get(name); },
    effect(factory) { cleanups.push(factory()); },
  };
  apply(context, h.settings);
  t.after(async () => { for (const close of cleanups.reverse()) await close(); });
  return { ...h, tools, processCalls, cleanups,
    execute(args, exec = {}, agent = h.owner.agent) { return h.ctx.agents.withInitiator(agent, () => tools.get('douyin_download').execute(args, { callId: 'entry-call', ...exec })); },
  };
}

test('plugin wait uses the initiating workspace and real files while registering a separate task controller', async t => {
  const h = await registered(t);
  const value = await h.execute(input);
  assert.equal(value.status, 'downloaded');
  assert.equal(value.downloadTask.state, 'completed');
  assert.equal(h.processCalls[0].cwd, h.workspace);
  assert.equal(h.processCalls[0].argv[h.processCalls[0].argv.indexOf('--project') + 1], h.workspace);
  assert.ok(h.tools.has('douyin_download_task'));
});

test('batch wait preserves link order and a middle source failure as partial', async t => {
  const urls = [receipt.source, 'https://www.douyin.com/video/7690548660732434410', 'https://www.douyin.com/video/7691377127358441866'];
  const h = await registered(t, { result: (url, h) => url === urls[1] ? { status: 'blocked', message: 'PUBLIC_SHARE_MEDIA_UNAVAILABLE' } : mediaReceipt(h.owner.agent, url) });
  const value = await h.execute({ urls, publicOnly: true });
  assert.equal(value.status, 'partial'); assert.equal(value.requested, 3); assert.equal(value.downloaded, 2);
  assert.deepEqual(h.processCalls.map(spec => spec.argv[spec.argv.indexOf('--url') + 1]), urls);
  assert.deepEqual(value.items.map(item => [item.index, item.status]), [[1, 'downloaded'], [2, 'blocked'], [3, 'downloaded']]);
  assert.equal(value.downloadTask.state, 'waiting_source');
});

test('missing runtime blocks before private registry or process work', async () => {
  const tools = new Map(), cleanup = [];
  apply({ agents: { requireInitiator: () => ({}) }, subprocess: { spawn() { throw new Error('must not spawn'); } },
    tools: { register(value) { tools.set(value.name, value); return () => {}; } }, effect(factory) { cleanup.push(factory()); } },
  { pythonExecutable: null, ffmpegExecutable: null, ffprobeExecutable: null, settingsHome: null });
  try {
    assert.equal((await tools.get('douyin_download').execute(input, {})).code, 'RUNTIME_UNAVAILABLE');
    assert.deepEqual((await tools.get('douyin_download').execute({ urls: [input.url], publicOnly: true }, {})).items.map(item => item.code), ['RUNTIME_UNAVAILABLE']);
  } finally { for (const close of cleanup.reverse()) await close(); }
});

test('unload waits for public subprocess completion before publishing interrupted state', async t => {
  let enter, release, spec;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const h = await registered(t, { subprocess: { spawn(value) { spec = value; enter(); return {
    done: held.then(() => ({ exitCode: 1, signal: 'SIGTERM' })), collected: { stdout: { readFrom: () => ({ text: '{}' }) } },
  }; } } });
  const work = h.execute(input);
  await entered;
  let settled = false;
  const stop = h.cleanups[0]().then(() => { settled = true; });
  assert.equal(spec.signal.aborted, true); await Promise.resolve(); assert.equal(settled, false);
  release(); await stop;
  assert.equal((await work).downloadTask.state, 'interrupted');
});

test('foreground fallback forwards independent bounds and preserves verified native task identity', async t => {
  const nativeId = 'a1234567-1234-1234-1234-123456789abc';
  const h = await registered(t, { result: () => ({ status: 'blocked', message: 'ACCESS_RESTRICTED' }), browser: {
    version: 4, supportsExpectedCwd: true, async download(agent, url, signal, bytes, timeout, options) {
      assert.equal(signal.aborted, false); assert.equal(bytes, settings.maxDownloadBytes); assert.equal(timeout, settings.nativeTimeoutMs); assert.deepEqual(options, { expectedCwd: h.workspace });
      return mediaReceipt(agent, url, { taskId: nativeId, targetVideoId: url.split('/').at(-1) });
    },
  } });
  const value = await h.execute({ url: input.url });
  assert.equal(value.taskId, nativeId); assert.notEqual(value.downloadTask.id, nativeId);
  assert.equal(value.status, 'downloaded');
});

test('unsupported public share data falls back to the selected work in the foreground', async t => {
  const nativeId = 'a1234567-1234-1234-1234-123456789abc';
  let calls = 0;
  const h = await registered(t, { result: () => ({ status: 'blocked', message: 'PUBLIC_SHARE_DATA_INVALID: The official share page returned unsupported video data.' }), browser: {
    version: 4, supportsExpectedCwd: true, async download(agent, url, signal, bytes, timeout, options) {
      calls++;
      assert.equal(url, input.url); assert.equal(signal.aborted, false);
      assert.equal(bytes, settings.maxDownloadBytes); assert.equal(timeout, settings.nativeTimeoutMs); assert.deepEqual(options, { expectedCwd: h.workspace });
      return mediaReceipt(agent, url, { taskId: nativeId, targetVideoId: url.split('/').at(-1) });
    },
  } });
  const value = await h.execute({ url: input.url });
  assert.equal(calls, 1);
  assert.equal(value.status, 'downloaded');
  assert.equal(value.taskId, nativeId);
  assert.equal(value.downloadTask.state, 'completed');
});

test('unsupported public share data uses the owned background browser and retains its verified receipt', async t => {
  const nativeId = 'a1234567-1234-1234-1234-123456789abc';
  let calls = 0;
  const h = await registered(t, { result: () => ({ status: 'blocked', message: 'PUBLIC_SHARE_DATA_INVALID: unsupported video data' }), browser: {
    version: 4, supportsBackgroundDownload: true, supportsExpectedCwd: true, async download(agent, url, signal, bytes, timeout, options) {
      calls++;
      assert.equal(url, input.url); assert.equal(signal.aborted, false);
      assert.equal(bytes, settings.maxDownloadBytes); assert.equal(timeout, settings.nativeTimeoutMs); assert.deepEqual(options, { background: true, expectedCwd: h.workspace });
      return mediaReceipt(agent, url, { taskId: nativeId, targetVideoId: url.split('/').at(-1) });
    },
  } });
  const accepted = await h.execute({ url: input.url, mode: 'background' });
  assert.equal(accepted.status, 'queued');
  await h.ctx.jobs.wait(accepted.downloadTask.jobId, 30000, h.owner.agent.id);
  const value = await h.ctx.agents.withInitiator(h.owner.agent, () => h.tools.get('douyin_download_task').execute({ action: 'status', taskId: accepted.downloadTask.id }, {}));
  assert.equal(calls, 1);
  assert.equal(value.downloadTask.state, 'completed');
  assert.equal(value.task.items[0].result.taskId, nativeId);
  assert.equal(value.task.items[0].result.full_decode_verified, true);
});

test('public-only does not use a browser when the share data is unsupported', async t => {
  let calls = 0;
  const h = await registered(t, { result: () => ({ status: 'blocked', message: 'PUBLIC_SHARE_DATA_INVALID: unsupported video data' }), browser: {
    version: 4, download() { calls++; throw new Error('public-only cannot open the browser'); },
  } });
  const value = await h.execute(input);
  assert.equal(value.status, 'blocked');
  assert.equal(value.downloadTask.state, 'waiting_source');
  assert.equal(calls, 0);
});

test('unsupported public share data reports the missing Desktop Host', async t => {
  const h = await registered(t, { result: () => ({ status: 'blocked', message: 'PUBLIC_SHARE_DATA_INVALID: unsupported video data' }) });
  const value = await h.execute({ url: input.url });
  assert.equal(value.status, 'blocked');
  assert.equal(value.code, 'DESKTOP_HOST_REQUIRED');
});

test('unsupported public share data preserves browser login requirements', async t => {
  const h = await registered(t, { result: () => ({ status: 'blocked', message: 'PUBLIC_SHARE_DATA_INVALID: unsupported video data' }), browser: {
    version: 4, supportsExpectedCwd: true, download: async () => ({ status: 'blocked', code: 'LOGIN_OR_VERIFICATION_REQUIRED' }),
  } });
  const value = await h.execute({ url: input.url });
  assert.equal(value.status, 'blocked');
  assert.equal(value.code, 'LOGIN_OR_VERIFICATION_REQUIRED');
  assert.equal(value.downloadTask.state, 'waiting_user');
});

test('local media and filesystem failures do not open a browser', async t => {
  for (const message of ['The video exceeded the configured download size limit.', 'The downloaded file did not pass the video readability check.', 'The output directory is unavailable.', 'The output filename contains PUBLIC_SHARE_DATA_INVALID.']) {
    let calls = 0;
    const h = await registered(t, { result: () => ({ status: 'blocked', message }), browser: {
      version: 4, download() { calls++; throw new Error('local failures cannot open the browser'); },
    } });
    const value = await h.execute({ url: input.url });
    assert.equal(value.status, 'blocked');
    assert.equal(calls, 0);
  }
});

test('unsupported share data cannot certify a browser result for a different work', async t => {
  const h = await registered(t, { result: () => ({ status: 'blocked', message: 'PUBLIC_SHARE_DATA_INVALID: unsupported video data' }), browser: {
    version: 4, supportsExpectedCwd: true, async download(agent, url) {
      return mediaReceipt(agent, url, { targetVideoId: '7100000000000000001' });
    },
  } });
  const value = await h.execute({ url: input.url });
  assert.notEqual(value.status, 'downloaded');
  assert.notEqual(value.downloadTask.state, 'completed');
});

for (const version of [1, 2, 3]) test(`browser acquisition version ${version} stays blocked`, async t => {
  let nativeCalls = 0;
  const h = await registered(t, { result: () => ({ status: 'blocked', message: 'ACCESS_RESTRICTED' }), browser: { version, download() { nativeCalls++; throw new Error('must not run'); } } });
  const value = await h.execute({ url: input.url });
  assert.equal(value.status, 'blocked'); assert.equal(value.code, 'DESKTOP_HOST_REQUIRED'); assert.equal(nativeCalls, 0);
});

test('background fallback refuses an old v4 capability instead of opening foreground playback', async t => {
  let nativeCalls = 0;
  const h = await registered(t, { result: () => ({ status: 'blocked', message: 'ACCESS_RESTRICTED' }), browser: { version: 4, download() { nativeCalls++; } } });
  const accepted = await h.execute({ url: input.url, mode: 'background' });
  await h.ctx.jobs.wait(accepted.downloadTask.jobId, 30000, h.owner.agent.id);
  const value = await h.ctx.agents.withInitiator(h.owner.agent, () => h.tools.get('douyin_download_task').execute({ action: 'status', taskId: accepted.downloadTask.id }, {}));
  assert.equal(value.task.items[0].result.code, 'DESKTOP_BACKGROUND_UNAVAILABLE'); assert.equal(nativeCalls, 0);
});

test('native and registry deployment bounds fail before registration', () => {
  assert.equal(settings.nativeTimeoutMs, 1800000);
  for (const nativeTimeoutMs of [999, 7200001, 1000.5, NaN, Infinity, '1800000', null]) assert.throws(() => resolveConfig({ nativeTimeoutMs }), /nativeTimeoutMs/);
  assert.throws(() => resolveConfig({ taskMaxTasks: 0 }), /taskMaxTasks/);
  assert.throws(() => resolveConfig({ timeoutMs: 7200000, nativeTimeoutMs: 7200000, maxVideos: 100 }), /timer range/);
});


test('public acquisition uses the accepted canonical output even if the Session link changes while its process runs', async t => {
  let original, replacement, selected;
  const calls = [];
  const h = await registered(t, { subprocess: { spawn(spec) {
    calls.push(spec);
    let result;
    return { done: (async () => {
      assert.equal(spec.cwd, original);
      assert.equal(spec.argv[spec.argv.indexOf('--project') + 1], original);
      await unlink(selected); await symlink(replacement, selected, process.platform === 'win32' ? 'junction' : 'dir');
      const url = spec.argv[spec.argv.indexOf('--url') + 1];
      result = await mediaReceipt({ session: { header: { cwd: spec.cwd } } }, url);
      return { exitCode: 0, signal: null };
    })(), collected: { stdout: { readFrom: () => ({ text: JSON.stringify(result) }) } } };
  } } });
  original = join(h.workspace, 'original'); replacement = join(h.workspace, 'replacement'); selected = join(h.workspace, 'selected');
  await mkdir(original); await mkdir(replacement); await symlink(original, selected, process.platform === 'win32' ? 'junction' : 'dir');
  const owner = await h.makeAgent('public-bound-workspace', selected);
  const result = await h.execute(input, {}, owner.agent);
  assert.equal(result.status, 'downloaded');
  assert.equal(result.downloadTask.state, 'completed');
  assert.equal(result.path, join(original, 'source/media/douyin', input.url.split('/').at(-1) + '.mp4'));
  assert.equal(calls.length, 1);
  assert.deepEqual(await readdir(replacement), []);
});

for (const supportsExpectedCwd of [undefined, false]) test(`rejects a legacy v4 browser with workspace capability ${String(supportsExpectedCwd)} before retargeted native output`, async t => {
  let original, replacement, selected, nativeCalls = 0;
  const h = await registered(t, { result: async () => {
    await unlink(selected); await symlink(replacement, selected, process.platform === 'win32' ? 'junction' : 'dir');
    return { status: 'blocked', message: 'PUBLIC_SHARE_MEDIA_UNAVAILABLE' };
  }, browser: {
    version: 4, supportsBackgroundDownload: true,
    ...(supportsExpectedCwd === undefined ? {} : { supportsExpectedCwd }),
    async download(agent, url) { nativeCalls++; return mediaReceipt(agent, url); },
  } });
  original = join(h.workspace, 'original'); replacement = join(h.workspace, 'replacement'); selected = join(h.workspace, 'selected');
  await mkdir(original); await mkdir(replacement);
  await symlink(original, selected, process.platform === 'win32' ? 'junction' : 'dir');
  const owner = await h.makeAgent('legacy-native-bound-workspace', selected);
  const result = await h.execute({ url: input.url }, {}, owner.agent);
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'DESKTOP_WORKSPACE_BINDING_UNAVAILABLE');
  assert.equal(nativeCalls, 0);
  assert.deepEqual(await readdir(original), []);
  assert.deepEqual(await readdir(replacement), []);
});
