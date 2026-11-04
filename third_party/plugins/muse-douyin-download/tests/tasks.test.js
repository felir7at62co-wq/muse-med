/** Durable-task behavior over built workspace peers, real Jobs/Agents/controllers and local decodable media only. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, stat, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setSandboxMode } from '../../../../packages/sandbox/sandbox-policy/lib/index.js';
import * as ToolJobs from '../../../../packages/jobs/tool-jobs/lib/index.js';
import { taskHarness } from './task-harness.js';
import { MP4, digest, mediaReceipt, selectedVideo, VIDEO_ONE, VIDEO_TWO, VIDEO_THREE, videoURL } from './task-fixtures.js';

const executeFile = promisify(execFile);
const manifestPath = fixture => join(fixture.settingsHome, 'plugin-data/muse-douyin-download/tasks/v1/registry.json');
const manifest = async fixture => JSON.parse(await readFile(manifestPath(fixture), 'utf8'));
const taskId = receipt => receipt.downloadTask.id;
const args = id => ({ url: videoURL(id), publicOnly: true });
const nativeEvidence = id => ({ responseStatus: 200, mediaHost: 'v3-fixture.douyinvod.com', mediaUrlHash: 'a'.repeat(64),
  association: 'provider-detail-verified', currentSrcMatched: false, provider: { detailResponseStatus: 200,
    detailHost: 'www.douyin.com', detailPath: '/aweme/v1/web/aweme/detail/', targetVideoId: id,
    documentEpoch: 1, sourceField: 'video.play_addr', durationMs: 1000, width: 16, height: 16 } });

describe('persistent Douyin tasks with owned Jobs', { timeout: 90000 }, () => {
  test('default wait preserves native identity and publishes a private durable receipt distinct from its real job', async t => {
    const nativeTaskId = '77000000-0000-4000-8000-000000000001';
    const f = await taskHarness(t, { acquireVideo: (agent, url) => mediaReceipt(agent, url, { authentication: 'muse-browser', taskId: nativeTaskId, targetVideoId: selectedVideo(url) }) });
    const result = await f.download(args(VIDEO_ONE));
    assert.equal(result.status, 'downloaded');
    assert.equal(result.taskId, nativeTaskId);
    assert.equal(result.targetVideoId, VIDEO_ONE);
    assert.match(taskId(result), /^dyt-[a-f0-9]{32}$/);
    assert.notEqual(taskId(result), nativeTaskId);
    assert.notEqual(taskId(result), result.downloadTask.jobId);
    assert.equal(result.downloadTask.state, 'completed');
    assert.equal(f.ctx.jobs.get(result.downloadTask.jobId, f.owner.agent.id).status, 'completed');
    assert.equal(digest(await readFile(result.path)), result.sha256);
    const record = await manifest(f);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.tasks[0].items[0].result.taskId, nativeTaskId);
    if (process.platform !== 'win32') {
      assert.equal((await stat(manifestPath(f))).mode & 0o777, 0o600);
      assert.equal((await stat(join(f.settingsHome, 'plugin-data/muse-douyin-download/tasks/v1'))).mode & 0o777, 0o700);
    }
    assert.equal(f.calls[0].background, false);
  });

  test('background completion survives the accepting tool signal and remains collectable through the real job controller', async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const f = await taskHarness(t, { async acquireVideo(agent, url, _publicOnly, signal) { entered.resolve(signal); await release.promise; signal.throwIfAborted(); return mediaReceipt(agent, url); } });
    f.releases.add(() => release.resolve());
    const caller = new AbortController();
    const accepted = await f.download({ ...args(VIDEO_ONE), mode: 'background' }, { signal: caller.signal });
    assert.equal(accepted.status, 'queued');
    const runnerSignal = await entered.promise;
    caller.abort(new Error('accepting tool is already complete'));
    assert.equal(runnerSignal.aborted, false);
    assert.equal(f.calls[0].background, true);
    assert.equal((await f.status(accepted)).task.state, 'running');
    release.resolve();
    const output = await f.jobTool('job_output', { job_id: accepted.downloadTask.jobId, wait: true, timeout_ms: 30000 });
    assert.notEqual(output.isError, true);
    assert.equal(output.value.job.status, 'completed');
    assert.equal((await f.status(accepted)).task.state, 'completed');
  });

  test('accepts a logged call once, rejects changed selection, and never replays the accepted download', async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const f = await taskHarness(t, { async acquireVideo(agent, url) { entered.resolve(); await release.promise; return mediaReceipt(agent, url); } });
    f.releases.add(() => release.resolve());
    const selection = { ...args(VIDEO_ONE), mode: 'background' };
    const accepted = await f.download(selection, { callId: 'same-logged-call' });
    await entered.promise;
    const repeated = await f.download(selection, { callId: 'same-logged-call' });
    assert.equal(taskId(repeated), taskId(accepted));
    assert.equal(repeated.downloadTask.jobId, accepted.downloadTask.jobId);
    assert.equal(repeated.status, 'queued');
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.download({ ...args(VIDEO_TWO), mode: 'background' }, { callId: 'same-logged-call' }), { code: 'DOUYIN_TASK_STALE' });
    release.resolve(); await f.settle(accepted);
    const completed = await f.download(selection, { callId: 'same-logged-call' });
    assert.equal(completed.status, 'downloaded');
    assert.equal(f.calls.length, 1);
    assert.equal((await manifest(f)).tasks.length, 1);
  });

  test('keeps an accepted call queued when its duplicate arrives before job admission finishes', async t => {
    const f = await taskHarness(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
    const start = f.tasks.start.bind(f.tasks);
    f.tasks.start = async (...values) => { entered.resolve(); await release.promise; return start(...values); };
    const selection = { ...args(VIDEO_ONE), mode: 'background' };
    const first = f.download(selection, { callId: 'accepted-before-admission' });
    f.releases.add(async () => { release.resolve(); await first; });
    await entered.promise;
    const repeated = await f.download(selection, { callId: 'accepted-before-admission' });
    assert.equal(repeated.status, 'queued');
    assert.equal(repeated.downloadTask.state, 'queued');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.ctx.jobs.list(f.owner.agent.id), []);
    release.resolve();
    const accepted = await first;
    assert.equal(taskId(repeated), taskId(accepted));
    await f.settle(accepted);
    assert.equal(f.calls.length, 1);
    assert.equal((await manifest(f)).tasks.length, 1);
  });

  test('status and list stay offline and fence foreign sessions, replacement cwd and real job access', async t => {
    const f = await taskHarness(t), completed = await f.download(args(VIDEO_ONE));
    const foreign = await f.makeAgent('foreign-owner');
    await assert.rejects(f.control({ action: 'status', taskId: taskId(completed) }, foreign.agent), { code: 'DOUYIN_TASK_FORBIDDEN' });
    assert.equal((await f.control({ action: 'list' }, foreign.agent)).count, 0);
    assert.throws(() => f.ctx.jobs.get(completed.downloadTask.jobId, foreign.agent.id));
    assert.equal((await f.status(completed)).task.state, 'completed');
    assert.equal((await f.control({ action: 'list' })).count, 1);
    const elsewhere = join(f.directory, 'other-workspace');
    await mkdir(elsewhere);
    await f.owner.dispose();
    const moved = await f.makeAgent(f.owner.agent.id, elsewhere);
    await assert.rejects(f.control({ action: 'status', taskId: taskId(completed) }, moved.agent), { code: 'DOUYIN_TASK_FORBIDDEN' });
    assert.equal((await f.control({ action: 'list' }, moved.agent)).count, 0);
    assert.equal(f.calls.length, 1);
  });

  test('read-only rejects before job admission or acquisition while offline inspection remains available', async t => {
    const f = await taskHarness(t);
    setSandboxMode(f.owner.agent.session, 'read-only');
    await assert.rejects(f.download({ ...args(VIDEO_ONE), mode: 'background' }), { code: 'DOUYIN_READ_ONLY' });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.ctx.jobs.list(f.owner.agent.id), []);
    assert.equal((await f.control({ action: 'list' })).count, 0);
  });

  test('requires the configured private state home instead of falling back to temporary task storage', async t => {
    let acquired = false;
    await assert.rejects(taskHarness(t, { settings: { settingsHome: null }, acquireVideo: () => { acquired = true; throw new Error('unexpected acquisition'); } }), { code: 'DOUYIN_TASK_STATE_HOME_REQUIRED' });
    assert.equal(acquired, false);
  });

  test('starts no media without a real controller and resumes explicitly after controller restoration', async t => {
    const f = await taskHarness(t);
    await f.controller.dispose();
    await assert.rejects(f.download({ ...args(VIDEO_ONE), mode: 'background' }), /no job controller/i);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.ctx.jobs.list(f.owner.agent.id), []);
    const list = await f.control({ action: 'list' });
    assert.equal(list.count, 1);
    assert.equal(list.tasks[0].task.state, 'interrupted');
    assert.equal(list.tasks[0].task.error.code, 'JOB_ADMISSION_FAILED');
    await f.ctx.plugin(ToolJobs, { completionDelivery: 'quiet' });
    const resumed = await f.control({ action: 'resume', taskId: list.tasks[0].downloadTask.id });
    await f.settle(resumed);
    assert.equal((await f.status(resumed)).task.state, 'completed');
    assert.equal(f.calls.length, 1);
  });

  test('refuses a symbolic-link private registry instead of reading or mutating its target', { skip: process.platform === 'win32' ? 'File symlinks require Windows developer mode or elevated privileges' : false }, async t => {
    const f = await taskHarness(t), completed = await f.download(args(VIDEO_ONE));
    const original = await readFile(manifestPath(f));
    const outside = join(f.directory, 'outside-registry.json');
    await writeFile(outside, original);
    await unlink(manifestPath(f));
    await symlink(outside, manifestPath(f));
    await assert.rejects(f.status(completed), { code: 'DOUYIN_TASK_LIMIT' });
    assert.deepEqual(await readFile(outside), original);
    assert.equal(f.calls.length, 1);
  });

  test('does not certify a symbolic-link media result even when its copied bytes and metadata agree', { skip: process.platform === 'win32' ? 'File symlinks require Windows developer mode or elevated privileges' : false }, async t => {
    const f = await taskHarness(t, { async acquireVideo(agent, url) {
      const result = await mediaReceipt(agent, url);
      const outside = join(f.directory, 'outside.mp4');
      await writeFile(outside, MP4); await unlink(result.path); await symlink(outside, result.path);
      return result;
    } });
    const result = await f.download(args(VIDEO_ONE));
    assert.notEqual(result.status, 'downloaded');
    const state = await f.status(result);
    assert.equal(state.task.state, 'interrupted');
    assert.equal(state.task.error.code, 'DOUYIN_RECEIPT_INVALID');
    assert.notEqual(state.task.items[0].state, 'completed');
  });

  test('deduplicates normalized same-video selections while retaining separate item receipts', async t => {
    const f = await taskHarness(t);
    const result = await f.download({ urls: [videoURL(VIDEO_ONE), 'https://www.douyin.com/?modal_id=' + VIDEO_ONE, videoURL(VIDEO_TWO)], publicOnly: true });
    assert.equal(result.status, 'complete');
    assert.equal(result.requested, 3);
    assert.equal(result.downloaded, 3);
    assert.deepEqual(f.calls.map(call => call.url), [videoURL(VIDEO_ONE), videoURL(VIDEO_TWO)]);
    const state = await f.status(result);
    assert.equal(state.task.items[0].result.path, state.task.items[1].result.path);
    assert.equal(state.task.items[1].videoId, VIDEO_ONE);
  });

  test('reuses a separately accepted task video only after verifying its existing project receipt', async t => {
    const f = await taskHarness(t), first = await f.download(args(VIDEO_ONE));
    const second = await f.download(args(VIDEO_ONE));
    assert.notEqual(taskId(second), taskId(first));
    assert.notEqual(second.downloadTask.jobId, first.downloadTask.jobId);
    assert.equal(second.status, 'downloaded');
    assert.equal(second.path, first.path);
    assert.equal(second.sha256, digest(await readFile(first.path)));
    assert.equal(f.calls.length, 1);
    assert.equal((await f.status(second)).task.items[0].reused, true);
    assert.equal((await f.control({ action: 'list' })).count, 2);
  });

  test('applies durable task capacity before admitting another job or acquisition', async t => {
    const f = await taskHarness(t, { settings: { taskMaxTasks: 1 } });
    await f.download(args(VIDEO_ONE));
    await assert.rejects(f.download(args(VIDEO_TWO)), { code: 'DOUYIN_TASK_LIMIT' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.ctx.jobs.list(f.owner.agent.id).length, 1);
    assert.equal((await f.control({ action: 'list' })).count, 1);
  });

  test('rejects an oversized source receipt without presenting the local media as completed', async t => {
    const f = await taskHarness(t, { settings: { taskReceiptMaxBytes: 1024 }, async acquireVideo(agent, url) {
      const result = await mediaReceipt(agent, url);
      const source = JSON.parse(await readFile(result.receipt, 'utf8'));
      source.padding = 'x'.repeat(2048);
      await writeFile(result.receipt, JSON.stringify(source));
      return result;
    } });
    const result = await f.download(args(VIDEO_ONE));
    assert.notEqual(result.status, 'downloaded');
    const status = await f.status(result);
    assert.equal(status.task.state, 'interrupted');
    assert.equal(status.task.error.code, 'DOUYIN_RECEIPT_INVALID');
    assert.notEqual(status.task.items[0].state, 'completed');
  });

  test('rejects future, unknown and receiptless completed registry records without executing any work', async t => {
    const f = await taskHarness(t), completed = await f.download(args(VIDEO_ONE));
    const original = await readFile(manifestPath(f));
    for (const corrupt of [record => { record.schemaVersion = 2; }, record => { record.tasks[0].state = 'definitely_succeeded'; }, record => { delete record.tasks[0].items[0].result; }]) {
      const record = JSON.parse(original.toString('utf8'));
      corrupt(record);
      await writeFile(manifestPath(f), JSON.stringify(record));
      try { await assert.rejects(f.status(completed), { code: 'DOUYIN_TASK_INVALID' }); }
      finally { await writeFile(manifestPath(f), original); }
    }
    assert.equal(f.calls.length, 1);
    assert.equal((await f.status(completed)).task.state, 'completed');
  });

  test('preserves partial progress and resumes in a new owned job without replaying a verified item', async t => {
    let permitted = false;
    const f = await taskHarness(t, { acquireVideo: (agent, url) => selectedVideo(url) === VIDEO_TWO && !permitted ? { status: 'blocked', code: 'LOGIN_OR_VERIFICATION_REQUIRED' } : mediaReceipt(agent, url) });
    const partial = await f.download({ urls: [videoURL(VIDEO_ONE), videoURL(VIDEO_TWO)], publicOnly: true });
    assert.equal(partial.status, 'partial');
    assert.equal(partial.downloaded, 1);
    assert.equal((await f.status(partial)).task.state, 'waiting_user');
    setSandboxMode(f.owner.agent.session, 'read-only');
    await assert.rejects(f.control({ action: 'resume', taskId: taskId(partial) }), { code: 'DOUYIN_READ_ONLY' });
    assert.equal(f.calls.length, 2);
    setSandboxMode(f.owner.agent.session, 'workspace-write');
    permitted = true;
    const controlSignal = new AbortController();
    const resumed = await f.control({ action: 'resume', taskId: taskId(partial) }, f.owner.agent, controlSignal.signal);
    controlSignal.abort(new Error('resume call completed'));
    assert.notEqual(resumed.downloadTask.jobId, partial.downloadTask.jobId);
    await f.settle(resumed);
    assert.equal((await f.status(resumed)).task.state, 'completed');
    assert.deepEqual(f.calls.map(call => call.url), [videoURL(VIDEO_ONE), videoURL(VIDEO_TWO), videoURL(VIDEO_TWO)]);
    assert.equal(f.calls.at(-1).background, true);
  });

  test('does not turn an unverified acquisition response into downloaded success', async t => {
    const f = await taskHarness(t, { acquireVideo: () => ({ status: 'downloaded', full_decode_verified: false }) });
    const result = await f.download(args(VIDEO_ONE));
    assert.notEqual(result.status, 'downloaded');
    const state = await f.status(result);
    assert.equal(state.task.error.code, 'DOUYIN_RECEIPT_INVALID');
    assert.equal(state.task.state, 'interrupted');
    assert.notEqual(state.task.items[0].state, 'completed');
  });

  for (const mode of ['wait', 'background']) test(mode + ' retains the verified file receipt if its completed-item registry write fails', async t => {
    const f = await taskHarness(t), transaction = f.tasks.store.transaction.bind(f.tasks.store);
    let rejectedCompletion = false;
    f.releases.add(() => { f.tasks.store.transaction = transaction; });
    f.tasks.store.transaction = (change, signal) => transaction(async registry => {
      const completed = new Set(registry.tasks.flatMap(task => task.items.filter(item => item.state === 'completed').map(item => task.id + ':' + item.index)));
      const result = await change(registry);
      const added = registry.tasks.some(task => task.items.some(item => item.state === 'completed' && !completed.has(task.id + ':' + item.index)));
      if (!rejectedCompletion && added) {
        rejectedCompletion = true;
        throw Object.assign(new Error('fixture rejected completed-item publication'), { code: 'EIO' });
      }
      return result;
    }, signal);
    let result = await f.download({ ...args(VIDEO_ONE), mode });
    const accepted = result;
    if (mode === 'background') {
      await f.settle(accepted);
      const output = await f.jobTool('job_output', { job_id: accepted.downloadTask.jobId, wait: true, timeout_ms: 30000 });
      assert.notEqual(output.isError, true);
      result = JSON.parse(output.value.text);
    } else assert.equal(result.status, 'partial');
    assert.equal(rejectedCompletion, true);
    assert.equal(result.downloadTask.state, 'interrupted');
    assert.equal(result.registrationError.code, 'EIO');
    assert.equal(result.registryStateRecorded, true);
    assert.equal(result.verifiedButUnrecordedReceipts.length, 1);
    const receipt = result.verifiedButUnrecordedReceipts[0];
    assert.equal(receipt.index, 1);
    assert.equal(receipt.status, 'downloaded');
    assert.equal(receipt.sha256, digest(await readFile(receipt.path)));
    assert.equal(JSON.parse(await readFile(receipt.receipt, 'utf8')).sha256, receipt.sha256);
    const saved = await f.status(accepted);
    assert.equal(saved.task.state, 'interrupted');
    assert.notEqual(saved.task.items[0].state, 'completed');
    assert.equal(f.calls.length, 1);
  });

  test('preserves sanitized native evidence in wait output and verifies that same evidence again before resume', async t => {
    let permitted = false;
    const nativeId = '77000000-0000-4000-8000-000000000002';
    const f = await taskHarness(t, { acquireVideo: (agent, url) => selectedVideo(url) === VIDEO_TWO && !permitted
      ? { status: 'blocked', code: 'LOGIN_OR_VERIFICATION_REQUIRED' }
      : mediaReceipt(agent, url, { authentication: 'muse-browser', taskId: nativeId, targetVideoId: selectedVideo(url), evidence: nativeEvidence(selectedVideo(url)) }) });
    const partial = await f.download({ urls: [videoURL(VIDEO_ONE), videoURL(VIDEO_TWO)], publicOnly: true });
    assert.equal(partial.status, 'partial');
    assert.deepEqual(partial.items[0].evidence, nativeEvidence(VIDEO_ONE));
    assert.equal(partial.items[0].taskId, nativeId);
    const original = await readFile(partial.items[0].receipt), altered = JSON.parse(original.toString('utf8'));
    altered.evidence.mediaUrlHash = 'b'.repeat(64);
    await writeFile(partial.items[0].receipt, JSON.stringify(altered));
    await assert.rejects(f.control({ action: 'resume', taskId: taskId(partial) }), { code: 'DOUYIN_RECEIPT_INVALID' });
    assert.equal(f.calls.length, 2);
    await writeFile(partial.items[0].receipt, original); permitted = true;
    const resumed = await f.control({ action: 'resume', taskId: taskId(partial) });
    await f.settle(resumed);
    const complete = await f.status(resumed);
    assert.equal(complete.task.state, 'completed');
    assert.deepEqual(complete.task.items[0].result.evidence, nativeEvidence(VIDEO_ONE));
    assert.equal(complete.task.items[0].result.taskId, nativeId);
    assert.equal(f.calls.filter(call => call.url === videoURL(VIDEO_ONE)).length, 1);
  });

  test('rejects unrecognized native evidence fields instead of retaining them in public task state', async t => {
    const f = await taskHarness(t, { acquireVideo: (agent, url) => mediaReceipt(agent, url, {
      taskId: '77000000-0000-4000-8000-000000000003', targetVideoId: selectedVideo(url),
      evidence: { ...nativeEvidence(selectedVideo(url)), authorization: 'Bearer synthetic-fixture-secret' },
    }) });
    const result = await f.download(args(VIDEO_ONE));
    assert.notEqual(result.status, 'downloaded');
    assert.equal((await f.status(result)).task.error.code, 'DOUYIN_RECEIPT_INVALID');
    assert.equal(JSON.stringify(result).includes('synthetic-fixture-secret'), false);
    assert.equal((await readFile(manifestPath(f), 'utf8')).includes('synthetic-fixture-secret'), false);
  });

  test('halts resume on a changed completed hash and requires explicit repair before retry', async t => {
    let permitted = false;
    const f = await taskHarness(t, { acquireVideo: (agent, url) => selectedVideo(url) === VIDEO_TWO && !permitted ? { status: 'blocked', code: 'SOURCE_UNAVAILABLE' } : mediaReceipt(agent, url) });
    const partial = await f.download({ urls: [videoURL(VIDEO_ONE), videoURL(VIDEO_TWO)], publicOnly: true });
    const path = partial.items[0].path, changed = Buffer.from(MP4); changed[0] ^= 1;
    await writeFile(path, changed);
    const count = f.ctx.jobs.list(f.owner.agent.id).length;
    await assert.rejects(f.control({ action: 'resume', taskId: taskId(partial) }), { code: 'DOUYIN_RECEIPT_INVALID' });
    assert.equal(f.calls.length, 2);
    assert.equal(f.ctx.jobs.list(f.owner.agent.id).length, count);
    assert.equal((await f.status(partial)).task.state, 'interrupted');
    await writeFile(path, MP4); permitted = true;
    const resumed = await f.control({ action: 'resume', taskId: taskId(partial) });
    await f.settle(resumed);
    assert.equal((await f.status(resumed)).task.state, 'completed');
    assert.equal(f.calls.filter(call => call.url === videoURL(VIDEO_ONE)).length, 1);
  });

  for (const action of ['task_cancel', 'job_kill', 'owner_dispose', 'plugin_unload']) test(action + ' waits for the producer I/O to drain before settlement', async t => {
    const entered = Promise.withResolvers(), aborted = Promise.withResolvers(), drained = Promise.withResolvers();
    const f = await taskHarness(t, { acquireVideo: (_agent, _url, _publicOnly, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted.resolve(); drained.promise.then(() => reject(signal.reason)); }, { once: true });
      entered.resolve();
    }) });
    f.releases.add(() => drained.resolve());
    const accepted = await f.download({ ...args(VIDEO_ONE), mode: 'background' });
    await entered.promise;
    let finished = false, operation;
    if (action === 'task_cancel') operation = f.control({ action: 'cancel', taskId: taskId(accepted) });
    if (action === 'owner_dispose') operation = f.owner.dispose();
    if (action === 'plugin_unload') operation = f.tasks.dispose();
    if (action === 'job_kill') {
      const result = await f.jobTool('job_kill', { job_id: accepted.downloadTask.jobId, reason: 'test no longer needs media' });
      assert.notEqual(result.isError, true);
      assert.equal(result.value.outcome, 'cancellation-requested');
      operation = f.settle(accepted);
    }
    operation = operation.then(value => { finished = true; return value; });
    await aborted.promise;
    assert.equal(finished, false);
    drained.resolve(); await operation;
    const saved = (await manifest(f)).tasks.find(task => task.id === taskId(accepted));
    assert.notEqual(saved.state, 'completed');
    assert.notEqual(saved.items[0].state, 'completed');
  });

  test('cancels a queued task promptly while preserving the preceding task admission barrier', async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), events = [];
    const f = await taskHarness(t, { async acquireVideo(agent, url, _publicOnly, signal) {
      events.push(selectedVideo(url));
      if (selectedVideo(url) === VIDEO_ONE) { entered.resolve(); await release.promise; }
      signal.throwIfAborted();
      return mediaReceipt(agent, url);
    } });
    f.releases.add(() => release.resolve());
    const first = await f.download({ ...args(VIDEO_ONE), mode: 'background' });
    await entered.promise;
    const second = await f.download({ ...args(VIDEO_TWO), mode: 'background' });
    const third = await f.download({ ...args(VIDEO_THREE), mode: 'background' });
    const cancelled = await f.control({ action: 'cancel', taskId: taskId(second) });
    assert.equal(cancelled.task.state, 'cancelled');
    assert.deepEqual(events, [VIDEO_ONE]);
    release.resolve();
    await Promise.all([f.settle(first), f.settle(third)]);
    assert.deepEqual(events, [VIDEO_ONE, VIDEO_THREE]);
    assert.equal((await f.status(third)).task.state, 'completed');
  });

  test('classifies a crashed owner as interrupted without replay and resumes only its unfinished video', async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'muse-douyin-restart-')));
    let f;
    t.after(async () => { if (f) await f.close(); else await rm(directory, { recursive: true, force: true }); });
    const child = fileURLToPath(new URL('./task-restart-child.js', import.meta.url));
    const result = await executeFile(process.execPath, [child, directory], { timeout: 30000, maxBuffer: 16384 });
    const crashed = JSON.parse(result.stdout.trim());
    f = await taskHarness(undefined, { directory, ownerId: 'restart-owner' });
    const before = await f.control({ action: 'status', taskId: crashed.taskId });
    assert.equal(before.task.state, 'interrupted');
    assert.equal(before.task.items[0].state, 'completed');
    assert.notEqual(before.task.items[1].state, 'completed');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.ctx.jobs.list(f.owner.agent.id), []);
    const resumed = await f.control({ action: 'resume', taskId: crashed.taskId });
    await f.settle(resumed);
    assert.equal((await f.status(resumed)).task.state, 'completed');
    assert.deepEqual(f.calls.map(call => call.url), [videoURL(VIDEO_TWO)]);
    assert.equal(taskId(resumed), crashed.taskId);
  });

  test('clears a previous process job token from waiting-user tasks before another job can reuse that ordinal', async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'muse-douyin-waiting-restart-')));
    let f;
    t.after(async () => { if (f) await f.close(); else await rm(directory, { recursive: true, force: true }); });
    const child = fileURLToPath(new URL('./task-restart-child.js', import.meta.url));
    const result = await executeFile(process.execPath, [child, directory, 'waiting-user'], { timeout: 30000, maxBuffer: 16384 });
    const previous = JSON.parse(result.stdout.trim());
    f = await taskHarness(undefined, { directory, ownerId: 'restart-owner' });
    const before = await f.control({ action: 'status', taskId: previous.taskId });
    assert.equal(before.task.state, 'waiting_user');
    assert.equal(before.downloadTask.jobId, null);
    assert.equal(f.calls.length, 0);
    const unrelated = await f.download(args(VIDEO_THREE));
    assert.equal((await f.control({ action: 'status', taskId: previous.taskId })).downloadTask.jobId, null);
    const resumed = await f.control({ action: 'resume', taskId: previous.taskId });
    assert.notEqual(resumed.downloadTask.jobId, unrelated.downloadTask.jobId);
    await f.settle(resumed);
    assert.equal((await f.status(resumed)).task.state, 'completed');
    assert.deepEqual(f.calls.map(call => call.url), [videoURL(VIDEO_THREE), videoURL(VIDEO_TWO)]);
  });
});
