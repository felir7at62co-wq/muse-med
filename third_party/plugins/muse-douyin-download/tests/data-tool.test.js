/** Registered data-tool lifetime and reuse of the existing verified downloader. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, resolveConfig } from '../src/index.js';

const url = 'https://www.douyin.com/video/7691637134771391771';
const workspace = join(tmpdir(), 'douyin-data-parser-workspace');
const exact = value => ({ value, precision: 'exact' });
const snapshot = () => ({ status: 'ok', source: 'creator-page', targetVideoId: '7691637134771391771', observedAt: '2026-10-06T12:00:00Z',
  counts: { play_count: exact(42), digg_count: exact(1), comment_count: exact(0), share_count: exact(0), collect_count: exact(0) },
  comments: { status: 'not-requested', items: [], cursor: null, hasMore: null } });
const receipt = { status: 'downloaded', full_decode_verified: true, source: url,
  path: join(workspace, 'source/media/douyin/7691637134771391771.mp4'), receipt: join(workspace, 'source/media/douyin/7691637134771391771.mp4.source.json'),
  bytes: 1024, sha256: 'a'.repeat(64), duration_seconds: 3.5 };
const config = { settingsHome: null, pythonExecutable: 'fixture-python', ffprobeExecutable: 'fixture-probe', ffmpegExecutable: 'fixture-decoder', dataTimeoutMs: 1000, maxComments: 2 };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function install(browser, output = receipt, settings = config) {
  const tools = new Map();
  const cleanups = [];
  const calls = { initiator: 0, process: [], lookup: 0 };
  const agent = { session: { header: { cwd: workspace } } };
  const ctx = {
    agents: { requireInitiator() { calls.initiator++; return agent; } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; } },
    subprocess: { spawn(spec) { calls.process.push(spec); if (typeof output === 'function') return output(spec); return { done: Promise.resolve({ exitCode: output.status === 'blocked' ? 1 : 0, signal: null }),
      collected: { stdout: { readFrom() { return { text: JSON.stringify(output), lossy: false, truncated: false }; } } } }; } },
    get(name) { assert.equal(name, 'douyinBrowser'); calls.lookup++; return browser; },
    effect(factory) { cleanups.push(factory()); },
  };
  apply(ctx, settings);
  let disposal;
  return { tool: tools.get('douyin_data'), downloadTool: tools.get('douyin_download'), tools, cleanups, calls, agent,
    dispose() { return disposal ??= (async () => { for (const cleanup of cleanups.reverse()) await cleanup(); })(); } };
}

test('data read uses the initiating agent and configured limits without media runtimes', async () => {
  let selection;
  const scope = install({ version: 3, async data(agent, request, signal) { assert.equal(agent, scope.agent); assert.equal(signal.aborted, false); selection = request; return snapshot(); } }, receipt,
    { pythonExecutable: null, ffprobeExecutable: null, ffmpegExecutable: null, dataTimeoutMs: 2000, maxComments: 2 });
  try {
    const result = await scope.tool.execute({ url, source: 'creator' }, {});
    assert.equal(result.counts.play_count.value, 42);
    assert.deepEqual(selection, { url, source: 'creator', comments: { enabled: false, count: 2 }, timeoutMs: 2000 });
    assert.equal(scope.calls.process.length, 0);
    assert.equal(scope.calls.initiator, 1);
    assert.equal(scope.tool.parameters.properties.commentLimit.maximum, 2);
    assert.equal(scope.tool.presentCall().card, 'generic');
    assert.deepEqual(scope.tool.presentResult({}, { content: [{ type: 'text', text: 'result' }] }).content, [{ type: 'text', text: 'result' }]);
    assert.equal(JSON.parse(scope.tool.output.render({}, result)[0].text).source, 'creator-page');
  } finally { await scope.dispose(); }
  assert.equal(scope.tools.size, 0);
});

test('tool JSON refuses cookie input and excessive comment limits before any service lookup', async () => {
  const scope = install({ version: 3, data() { throw new Error('Not admitted'); } });
  try {
    for (const args of [{ url, cookieFile: '/private' }, { url, source: 'oauth' }, { url, includeComments: true, commentLimit: 3 }]) await assert.rejects(scope.tool.execute(args, {}));
    assert.equal(scope.calls.initiator, 0);
    assert.equal(scope.calls.lookup, 0);
    assert.equal(scope.calls.process.length, 0);
    assert.throws(() => resolveConfig({ dataTimeoutMs: 999 }));
    assert.throws(() => resolveConfig({ maxComments: 201 }));
  } finally { await scope.dispose(); }
});

test('older or missing bridges report the required Desktop data capability', async () => {
  for (const bridge of [undefined, { version: 2, data() { throw new Error('Older bridge must not run'); } }]) {
    const scope = install(bridge);
    try { assert.deepEqual(await scope.tool.execute({ url }, {}), { status: 'blocked', code: 'DESKTOP_HOST_REQUIRED' }); }
    finally { await scope.dispose(); }
  }
});

test('unverified creator ownership stays unavailable without substituting public views', async () => {
  const scope = install({ version: 3, async data(_agent, selection) { assert.equal(selection.source, 'creator'); return { status: 'blocked', code: 'CREATOR_OWNERSHIP_UNVERIFIED', raw: 'private' }; } });
  try { assert.deepEqual(await scope.tool.execute({ url, source: 'creator' }, {}), { status: 'blocked', code: 'CREATOR_OWNERSHIP_UNVERIFIED' }); }
  finally { await scope.dispose(); }
});

test('optional video acquisition shares the existing public downloader and verified receipt', async () => {
  const scope = install({ version: 3, async data() { return snapshot(); } });
  try {
    const result = await scope.tool.execute({ url, download: true }, {});
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.download, receipt);
    assert.equal(scope.calls.process.length, 1);
    const spec = scope.calls.process[0];
    assert.equal(spec.cwd, workspace);
    assert.equal(spec.argv[spec.argv.indexOf('--url') + 1], url);
    assert.ok(spec.argv.includes('--public-only'));
    assert.equal(spec.argv[spec.argv.indexOf('--ffmpeg') + 1], config.ffmpegExecutable);
  } finally { await scope.dispose(); }
});

test('the new bridge retains existing verified internal-browser download fallback', async () => {
  let native = 0;
  const scope = install({ version: 3, async data() { return snapshot(); }, async download(agent, selected, signal, limit) {
    native++; assert.equal(agent, scope.agent); assert.equal(selected, url); assert.equal(signal.aborted, false); assert.equal(limit, 512 * 1024 ** 2); return receipt;
  } }, { status: 'blocked', message: 'ACCESS_RESTRICTED' });
  try {
    assert.deepEqual((await scope.tool.execute({ url, download: true }, {})).download, receipt);
    assert.deepEqual(await scope.downloadTool.execute({ url }, {}), receipt);
    assert.equal(native, 2);
    assert.equal(scope.calls.process.length, 2);
  } finally { await scope.dispose(); }
});

test('available data and blocked media retain independent outcomes', async () => {
  const scope = install({ version: 3, async data() { return snapshot(); } }, receipt, { pythonExecutable: null, ffprobeExecutable: null, ffmpegExecutable: null });
  try {
    const result = await scope.tool.execute({ url, download: true }, {});
    assert.equal(result.status, 'partial');
    assert.equal(result.download.code, 'RUNTIME_UNAVAILABLE');
    assert.equal(scope.calls.process.length, 0);
  } finally { await scope.dispose(); }
});

test('unload waits for an admitted read and refuses its late result and optional download', async () => {
  const entered = deferred(); const read = deferred(); const aborted = deferred(); let dataSignal;
  const scope = install({ version: 3, data(_agent, _selection, signal) { dataSignal = signal; signal.addEventListener('abort', () => { aborted.resolve(); }, { once: true }); entered.resolve(); return read.promise; } });
  const operation = scope.tool.execute({ url, download: true }, {});
  const refused = assert.rejects(operation, /unloaded/);
  await entered.promise;
  let disposed = false;
  const stop = scope.dispose().then(() => { disposed = true; });
  try {
    await aborted.promise;
    assert.equal(dataSignal.aborted, true);
    await Promise.resolve(); assert.equal(disposed, false);
    read.resolve(snapshot());
    await refused; await stop;
    assert.equal(disposed, true);
    assert.equal(scope.calls.process.length, 0);
    await assert.rejects(scope.tool.execute({ url }, {}), /unloaded/);
    assert.equal(scope.calls.initiator, 1);
  } finally { read.resolve(snapshot()); await scope.dispose(); }
});

test('caller cancellation settles the admitted read without starting optional media', async () => {
  const entered = deferred(); const read = deferred(); let dataSignal;
  const scope = install({ version: 3, data(_agent, _selection, signal) { dataSignal = signal; entered.resolve(); return read.promise; } });
  const cancel = new AbortController();
  const operation = scope.tool.execute({ url, download: true }, { signal: cancel.signal });
  const refused = assert.rejects(operation, /user cancelled/);
  try {
    await entered.promise; cancel.abort(new Error('user cancelled'));
    assert.equal(dataSignal.aborted, true);
    let settled = false; operation.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    read.resolve(snapshot()); await refused;
    assert.equal(scope.calls.process.length, 0);
  } finally { read.resolve(snapshot()); await scope.dispose(); }
});

test('the deployment deadline aborts the read and still joins its completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred(); const read = deferred(); let dataSignal;
  const scope = install({ version: 3, data(_agent, _selection, signal) { dataSignal = signal; entered.resolve(); return read.promise; } });
  const operation = scope.tool.execute({ url }, {});
  try {
    await entered.promise; t.mock.timers.tick(31000);
    assert.equal(dataSignal.aborted, true);
    let settled = false; operation.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    read.resolve(snapshot());
    assert.deepEqual(await operation, { status: 'blocked', code: 'TRANSPORT_TIMEOUT' });
  } finally { read.resolve(snapshot()); await scope.dispose(); t.mock.timers.reset(); }
});

test('the page deadline retains its specific result within the transport allowance', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred(); const read = deferred(); let dataSignal;
  const scope = install({ version: 3, data(_agent, _selection, signal) { dataSignal = signal; entered.resolve(); return read.promise; } });
  const operation = scope.tool.execute({ url }, {});
  try {
    await entered.promise; t.mock.timers.tick(1000);
    assert.equal(dataSignal.aborted, false);
    read.resolve({ status: 'blocked', code: 'PUBLIC_DATA_UNAVAILABLE' });
    assert.deepEqual(await operation, { status: 'blocked', code: 'PUBLIC_DATA_UNAVAILABLE' });
  } finally { read.resolve(snapshot()); await scope.dispose(); t.mock.timers.reset(); }
});

test('batch reads enter one guest operation at a time and preserve each work identity', async () => {
  const urls = [url, 'https://www.douyin.com/video/7690548660732434410'];
  const entered = deferred(); const first = deferred(); const calls = [];
  const scope = install({ version: 3, data(_agent, selection) {
    calls.push(selection.url);
    const result = { ...snapshot(), targetVideoId: selection.url.split('/').at(-1) };
    if (calls.length === 1) { entered.resolve(); return first.promise.then(() => result); }
    return Promise.resolve(result);
  } });
  const operation = scope.tool.execute({ urls }, {});
  try {
    await entered.promise;
    assert.deepEqual(calls, [urls[0]]);
    first.resolve();
    const result = await operation;
    assert.deepEqual(calls, urls);
    assert.equal(result.status, 'complete');
    assert.equal(result.requested, 2);
    assert.equal(result.completed, 2);
    assert.equal(result.dataAvailable, 2);
    assert.equal(result.downloaded, 0);
    assert.deepEqual(result.items.map(item => [item.index, item.url]), [[1, urls[0]], [2, urls[1]]]);
  } finally { first.resolve(); await operation; await scope.dispose(); }
});

test('batch source failures do not prevent later reads and media failures preserve available data', async () => {
  const urls = [url, 'https://www.douyin.com/video/7690548660732434410', 'https://www.douyin.com/video/7691377127358441866'];
  const scope = install({ version: 3, async data(_agent, request) {
    if (request.url === urls[1]) return { status: 'blocked', code: 'CREATOR_OWNERSHIP_UNVERIFIED' };
    return { ...snapshot(), targetVideoId: request.url.split('/').at(-1) };
  } }, () => { throw new Error('private media diagnostics must not enter data output'); });
  try {
    const result = await scope.tool.execute({ urls, download: true }, {});
    assert.equal(result.status, 'partial');
    assert.equal(result.completed, 3);
    assert.equal(result.dataAvailable, 2);
    assert.equal(result.downloaded, 0);
    assert.deepEqual(result.items.map(item => [item.status, item.download.code]), [['partial', 'DOWNLOAD_FAILED'], ['blocked', 'DOWNLOAD_FAILED'], ['partial', 'DOWNLOAD_FAILED']]);
    assert.equal(result.items[0].counts.play_count.value, 42);
    assert.equal(result.items[1].code, 'CREATOR_OWNERSHIP_UNVERIFIED');
    assert.ok(!JSON.stringify(result).includes('private'));
  } finally { await scope.dispose(); }
});

test('video acquisition can succeed while page data remains explicitly unavailable', async () => {
  const scope = install({ version: 3, async data() { return { status: 'blocked', code: 'CREATOR_OWNERSHIP_UNVERIFIED' }; } });
  try {
    const result = await scope.tool.execute({ url, download: true }, {});
    assert.equal(result.status, 'partial');
    assert.equal(result.code, 'CREATOR_OWNERSHIP_UNVERIFIED');
    assert.deepEqual(result.download, receipt);
    assert.equal(result.counts, undefined);
  } finally { await scope.dispose(); }
});

test('invalid or rejected page results produce bounded per-work diagnostics', async () => {
  for (const bridge of [{ version: 3, async data() { return { ...snapshot(), targetVideoId: '7691637134771391772', private: 'secret' }; } },
    { version: 3, async data() { throw new Error('private account diagnostics'); } }]) {
    const scope = install(bridge);
    try {
      const result = await scope.tool.execute({ urls: [url] }, {});
      assert.equal(result.status, 'blocked');
      assert.equal(result.dataAvailable, 0);
      assert.ok(['INVALID_RESULT', 'HOST_UNAVAILABLE'].includes(result.items[0].code));
      assert.ok(!JSON.stringify(result).includes('private'));
    } finally { await scope.dispose(); }
  }
});

test('an escaping media receipt cannot turn available data into a verified download', async () => {
  const scope = install({ version: 3, async data() { return snapshot(); } }, { ...receipt, path: join(tmpdir(), 'outside-data-video.mp4') });
  try {
    const result = await scope.tool.execute({ url, download: true }, {});
    assert.equal(result.status, 'partial');
    assert.equal(result.counts.play_count.value, 42);
    assert.deepEqual(result.download, { status: 'blocked', code: 'DOWNLOAD_FAILED' });
  } finally { await scope.dispose(); }
});

test('comment refusal makes an observed work partial without changing its total', async () => {
  const scope = install({ version: 3, async data() { return { ...snapshot(), counts: { ...snapshot().counts, comment_count: exact(14) }, comments: { status: 'blocked', code: 'COMMENTS_UNAVAILABLE' } }; } });
  try {
    const result = await scope.tool.execute({ url, includeComments: true }, {});
    assert.equal(result.status, 'partial');
    assert.equal(result.counts.comment_count.value, 14);
    assert.equal(result.comments.items.length, 0);
    assert.equal(result.comments.code, 'COMMENTS_UNAVAILABLE');
  } finally { await scope.dispose(); }
});

test('cancelled batches join the admitted read and append completed work to the registry error', async () => {
  const urls = [url, 'https://www.douyin.com/video/7690548660732434410'];
  const entered = deferred(); const second = deferred(); let calls = 0; let dataSignal;
  const scope = install({ version: 3, data(_agent, request, signal) {
    calls++;
    if (calls === 1) return Promise.resolve(snapshot());
    dataSignal = signal; entered.resolve(); return second.promise;
  } });
  const cancel = new AbortController(); const exec = { signal: cancel.signal };
  const operation = scope.tool.execute({ urls }, exec);
  const refused = assert.rejects(operation, /user cancelled/);
  try {
    await entered.promise; cancel.abort(new Error('user cancelled'));
    assert.equal(dataSignal.aborted, true);
    let settled = false; operation.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    second.resolve({ ...snapshot(), targetVideoId: urls[1].split('/').at(-1) }); await refused;
    const original = [{ type: 'text', text: 'Error: tool call aborted' }];
    const content = scope.tool.finalizeContent(exec, { isError: true, content: original });
    assert.deepEqual(content[0], original[0]);
    const partial = JSON.parse(content[1].text);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.cancelled, true);
    assert.equal(partial.requested, 2);
    assert.equal(partial.completed, 1);
    assert.equal(partial.dataAvailable, 1);
    assert.equal(partial.items[0].url, url);
    assert.equal(scope.tool.finalizeContent(exec, { content: original }), undefined);
  } finally { second.resolve(snapshot()); await scope.dispose(); }
});

test('cancelled optional download retains its observed metadata and waits for child exit', async () => {
  const entered = deferred(); const child = deferred(); let processSignal;
  const scope = install({ version: 3, async data() { return snapshot(); } }, spec => {
    processSignal = spec.signal; entered.resolve(); return { done: child.promise,
      collected: { stdout: { readFrom() { return { text: JSON.stringify(receipt), lossy: false, truncated: false }; } } } };
  });
  const cancel = new AbortController(); const exec = { signal: cancel.signal };
  const operation = scope.tool.execute({ url, download: true }, exec);
  const refused = assert.rejects(operation, /user cancelled/);
  try {
    await entered.promise; cancel.abort(new Error('user cancelled'));
    assert.equal(processSignal.aborted, true);
    let settled = false; operation.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    child.resolve({ exitCode: 0, signal: null }); await refused;
    const content = scope.tool.finalizeContent(exec, { isError: true, content: [{ type: 'text', text: 'Error: tool call aborted' }] });
    const partial = JSON.parse(content[1].text);
    assert.equal(partial.items[0].counts.play_count.value, 42);
    assert.deepEqual(partial.items[0].download, { status: 'blocked', code: 'CANCELLED' });
    assert.equal(partial.downloaded, 0);
  } finally { child.resolve({ exitCode: 0, signal: null }); await scope.dispose(); }
});
