/** Durable task ownership, cleanup acknowledgement and generation-fenced control without platform requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HongguoTasks } from '../src/tasks.js';
import { resolveConfig } from '../src/config.js';
import { TaskStore } from '../src/task-store.js';
const defer = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };

async function fixture(run) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'muse-hongguo-tasks-')));
  const config = resolveConfig({ taskPollIntervalMs: 20, taskControlWaitMs: 1000 });
  let calls = 0;
  const client = {
    async resolveTaskRequest(args) { return { request: { ...args, sourceMode: args.sourceMode ?? 'legacy', quality: args.quality ?? '720p', outputDir: args.outputDir ?? join(cwd, 'downloads') }, sourceIdentity: 'fixture:720p', checkpointDirectory: join(cwd, 'checkpoint') }; },
    async download(args, signal, workspace, policy, observer) { calls++; return run ? run({ args, signal, workspace, policy, observer }) : { ok: true, complete: false, retainedEpisodeCount: 2, remainingEpisodeCount: 0 }; },
  };
  const caller = { kind: 'cli', operatorId: 'operator-1', cwd, policy: { mode: 'workspace-write', workspaceRoot: cwd } };
  const tasks = new HongguoTasks(config, { client });
  return { cwd, config, client, caller, tasks, calls: () => calls, cleanup: async () => { await tasks.dispose(); await rm(cwd, { recursive: true, force: true }); } };
}

test('foreground CLI records a frozen request and completed subset without claiming a full series', async () => {
  const f = await fixture();
  try {
    const result = await f.tasks.download({ seriesIds: ['123'], episodes: [1, 2] }, f.caller);
    assert.equal(result.ok, true); assert.equal(result.state, 'completed'); assert.equal(result.complete, false);
    assert.equal(result.task.request.quality, '720p'); assert.equal(result.task.owner.kind, 'cli');
    assert.equal((await f.tasks.control({ action: 'list' }, f.caller)).tasks.length, 1);
    const foreign = { ...f.caller, operatorId: 'other-operator' };
    assert.equal((await f.tasks.control({ action: 'status', taskId: result.taskId }, foreign)).code, 'task_forbidden');
  } finally { await f.cleanup(); }
});

test('read-only admission and agentless background requests start no downloads', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.tasks.download({ seriesIds: ['123'] }, { ...f.caller, policy: { mode: 'read-only' } })).code, 'file_access_denied');
    assert.equal((await f.tasks.download({ seriesIds: ['123'], mode: 'background' }, f.caller)).code, 'task_jobs_unavailable');
    assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test('same-process pause waits for cleanup, preserves metadata and resumes the frozen selection', async () => {
  const began = defer(), cleanup = defer();
  let first = true;
  const f = await fixture(async ({ signal, args }) => {
    if (!first) { assert.equal(args.quality, '720p'); return { ok: true, complete: true }; }
    first = false; began.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await cleanup.promise; return { ok: false, code: 'cancelled' };
  });
  try {
    const downloading = f.tasks.download({ seriesIds: ['123'] }, f.caller);
    await began.promise;
    const row = (await f.tasks.control({ action: 'list' }, f.caller)).tasks[0];
    const pausing = f.tasks.control({ action: 'pause', taskId: row.id, expectedRunId: row.runId }, f.caller);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.tasks.control({ action: 'status', taskId: row.id }, f.caller)).state, 'running');
    cleanup.resolve();
    assert.equal((await pausing).control.state, 'acknowledged');
    assert.equal((await downloading).state, 'paused');
    const resumed = await f.tasks.control({ action: 'resume', taskId: row.id }, f.caller);
    assert.equal(resumed.state, 'completed'); assert.notEqual(resumed.runId, row.runId);
  } finally { cleanup.resolve(); await f.cleanup(); }
});

test('cross-instance cancellation uses the exact run and waits for acknowledgement', async () => {
  const began = defer();
  const f = await fixture(async ({ signal }) => { began.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return { ok: false, code: 'cancelled' }; });
  const other = new HongguoTasks(f.config, { client: f.client });
  try {
    const downloading = f.tasks.download({ seriesIds: ['123'] }, f.caller);
    await began.promise;
    const row = (await other.control({ action: 'list' }, f.caller)).tasks[0];
    assert.equal(row.state, 'running');
    const stopped = await other.control({ action: 'cancel', taskId: row.id, expectedRunId: row.runId }, f.caller);
    assert.equal(stopped.control.state, 'acknowledged'); assert.equal(stopped.state, 'cancelled');
    await downloading;
    assert.equal((await other.control({ action: 'pause', taskId: row.id, expectedRunId: 'hgr-' + 'f'.repeat(32) }, f.caller)).code, 'task_stale_run');
  } finally { await other.dispose(); await f.cleanup(); }
});

test('unconfirmed native cleanup remains blocked and cannot be resumed or removed', async () => {
  const f = await fixture(async () => ({ ok: false, code: 'cleanup_unconfirmed', cleanupPendingPath: '/retained/private-stage' }));
  try {
    const row = await f.tasks.download({ seriesIds: ['123'] }, f.caller);
    assert.equal(row.state, 'blocked');
    assert.equal((await f.tasks.control({ action: 'resume', taskId: row.taskId }, f.caller)).code, 'task_locked');
    assert.equal((await f.tasks.control({ action: 'remove', taskId: row.taskId }, f.caller)).ok, false);
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

test('removing an inactive record leaves media and checkpoint bytes unchanged', async () => {
  const f = await fixture();
  try {
    const row = await f.tasks.download({ seriesIds: ['123'] }, f.caller);
    const file = join(f.cwd, 'kept.mp4'); await writeFile(file, 'verified media');
    const removed = await f.tasks.control({ action: 'remove', taskId: row.taskId }, f.caller);
    assert.equal(removed.removed, true); assert.equal(await readFile(file, 'utf8'), 'verified media');
    assert.deepEqual((await f.tasks.control({ action: 'list' }, f.caller)).tasks, []);
  } finally { await f.cleanup(); }
});

test('restart classifies an abandoned run under its run lock and never replays downloads', async () => {
  const f = await fixture();
  try {
    const row = await f.tasks.download({ seriesIds: ['123'] }, f.caller);
    const store = new TaskStore(f.cwd, f.config);
    await store.change(row.taskId, current => { current.state = 'running'; current.runnerPid = 2147483647; return current; });
    const fresh = new HongguoTasks(f.config, { client: f.client });
    const status = await fresh.control({ action: 'status', taskId: row.taskId }, f.caller);
    assert.equal(status.state, 'interrupted'); assert.equal(f.calls(), 1);
    await fresh.dispose();
  } finally { await f.cleanup(); }
});

function sessionDependencies(f, policy = () => f.caller.policy) {
  const agent = { id: 'session-fixture', session: { id: 'session-fixture', header: { cwd: f.cwd } } };
  const specifications = [], hooks = [];
  const jobs = { start(spec) {
    specifications.push(spec);
    const job = { id: 'hongguo-download-' + String(specifications.length).padStart(16, '0'), updateProgress() {} };
    hooks.push(spec.run(job)); return job.id;
  } };
  const tasks = new HongguoTasks(f.config, { client: f.client, jobs, agents: { get: id => id === agent.id ? agent : undefined }, resolvePolicy: policy });
  return { tasks, agent, jobs, hooks, specifications, caller: { kind: 'session', agent } };
}

test('background detaches the accepted tool signal and logs exact PTC call/root IDs', async () => {
  const finish = defer(), began = defer(); let aborted = false;
  const f = await fixture(async ({ signal }) => { signal.addEventListener('abort', () => { aborted = true; }); began.resolve(); await finish.promise; return { ok: true, complete: true }; });
  const session = sessionDependencies(f), signal = new AbortController();
  try {
    const accepted = await session.tasks.download({ seriesIds: ['123'], mode: 'background' }, session.caller,
      { signal: signal.signal, callId: 'ptc-child-call', rootCallId: 'outer-ptc-call' });
    await began.promise; signal.abort(); assert.equal(aborted, false);
    assert.deepEqual(session.specifications[0].toolCall, { callId: 'ptc-child-call', rootCallId: 'outer-ptc-call' });
    const repeat = await session.tasks.download({ seriesIds: ['123'], mode: 'background' }, session.caller,
      { callId: 'ptc-child-call', rootCallId: 'outer-ptc-call' });
    assert.equal(repeat.taskId, accepted.taskId); assert.equal(f.calls(), 1);
    finish.resolve(); await session.hooks[0].done;
    assert.equal((await session.tasks.control({ action: 'status', taskId: accepted.taskId }, session.caller)).state, 'completed');
  } finally { finish.resolve(); await session.tasks.dispose(); await f.cleanup(); }
});

test('failed background work retains only safe source diagnostics after a restart', async () => {
  const f = await fixture(async () => ({
    ok: false, complete: false, code: 'source_unavailable',
    sourceStage: 'video_model', retryable: false,
    upstreamCode: 'PRIVATE_UPSTREAM_CODE', message: 'https://private.invalid/request',
    sourceFailures: [
      { source: 'web', code: 'PREVIEW_ONLY', message: 'private upstream response' },
      { source: 'app', code: 'HTTP_429' },
      { source: 'api', code: 'PRIVATE_SOURCE_CODE' },
      { source: 'api', code: 'https://private.invalid/source' },
    ],
  }));
  const session = sessionDependencies(f);
  const restarted = sessionDependencies(f, () => ({ mode: 'read-only' }));
  try {
    const accepted = await session.tasks.download({ seriesIds: ['123'], mode: 'background' }, session.caller,
      { callId: 'diagnostic-child', rootCallId: 'diagnostic-root' });
    await session.hooks[0].done;
    const diagnostic = {
      sourceStage: 'video_model', retryable: false,
      sourceFailures: [{ source: 'web', code: 'PREVIEW_ONLY' }, { source: 'app', code: 'HTTP_429' }],
    };
    const status = await restarted.tasks.control({ action: 'status', taskId: accepted.taskId }, restarted.caller);
    assert.equal(status.task.state, 'failed');
    assert.equal(status.task.summary.code, 'source_unavailable');
    assert.deepEqual(status.task.summary.sourceDiagnostic, diagnostic);
    const list = await restarted.tasks.control({ action: 'list' }, restarted.caller);
    assert.deepEqual(list.tasks[0].summary.sourceDiagnostic, diagnostic);
    const persisted = await readFile(join(f.cwd, f.config.taskDirectory, accepted.taskId + '.json'), 'utf8');
    assert.deepEqual(JSON.parse(persisted).summary.sourceDiagnostic, diagnostic);
    assert.doesNotMatch(persisted + JSON.stringify(status) + JSON.stringify(list), /private\.invalid|private upstream|PRIVATE_/);
    assert.equal(f.calls(), 1);
  } finally { await restarted.tasks.dispose(); await session.tasks.dispose(); await f.cleanup(); }
});

test('a source failure without provider reasons remains readable without inventing a reason', async () => {
  const f = await fixture(async () => ({ ok: false, code: 'source_unavailable', sourceStage: 'video_model', retryable: false }));
  try {
    const result = await f.tasks.download({ seriesIds: ['123'] }, f.caller);
    assert.deepEqual(result.task.summary.sourceDiagnostic, { sourceStage: 'video_model', retryable: false });
  } finally { await f.cleanup(); }
});

test('state records predating source diagnostics still support status and list', async () => {
  const f = await fixture(async () => ({ ok: false, code: 'source_unavailable' }));
  try {
    const result = await f.tasks.download({ seriesIds: ['123'] }, f.caller);
    const path = join(f.cwd, f.config.taskDirectory, result.taskId + '.json');
    const legacy = JSON.parse(await readFile(path, 'utf8'));
    legacy.summary = { ok: false, code: 'source_unavailable', complete: false };
    await writeFile(path, JSON.stringify(legacy));
    const status = await f.tasks.control({ action: 'status', taskId: result.taskId }, f.caller);
    assert.deepEqual(status.task.summary, legacy.summary);
    const listed = await f.tasks.control({ action: 'list' }, f.caller);
    assert.deepEqual(listed.tasks[0].summary, legacy.summary);
  } finally { await f.cleanup(); }
});

test('a Session background call without its actual root call starts no job or download', async () => {
  const f = await fixture(), session = sessionDependencies(f);
  try {
    const result = await session.tasks.download({ seriesIds: ['123'], mode: 'background' }, session.caller, { callId: 'child' });
    assert.equal(result.code, 'task_call_required'); assert.equal(f.calls(), 0); assert.equal(session.specifications.length, 0);
  } finally { await session.tasks.dispose(); await f.cleanup(); }
});

test('execution rechecks current policy after accepting a frozen external destination', async () => {
  const { HongguoDownloadClient } = await import('../src/client.js');
  const f = await fixture();
  let policy = { mode: 'danger-full-access' }, resolves = 0;
  const real = new HongguoDownloadClient({ ...f.config, quality: '720p' }, { source: { identity: 'fixed-fixture' } });
  f.client.resolveTaskRequest = async (...args) => {
    const spec = await real.resolveTaskRequest(...args);
    if (++resolves === 1) policy = { mode: 'workspace-write', workspaceRoot: f.cwd };
    return spec;
  };
  const session = sessionDependencies(f, () => policy);
  try {
    const result = await session.tasks.download({ seriesIds: ['123'], outputDir: join(f.cwd, '..', 'external-download') }, session.caller,
      { callId: 'download-child', rootCallId: 'download-root' });
    assert.equal(result.ok, false); assert.equal(result.code, 'file_access_denied'); assert.equal(f.calls(), 0);
  } finally { await session.tasks.dispose(); await real.dispose(); await f.cleanup(); }
});

test('disk request, progress and summary extras are refused instead of returned to a model', async () => {
  const f = await fixture();
  try {
    const row = await f.tasks.download({ seriesIds: ['123'] }, f.caller);
    const path = join(f.cwd, f.config.taskDirectory, row.taskId + '.json');
    const original = JSON.parse(await readFile(path, 'utf8'));
    for (const field of ['request', 'progress', 'summary']) {
      const value = structuredClone(original);
      value[field] = { ...(value[field] ?? {}), secret: 'private-field' };
      await writeFile(path, JSON.stringify(value));
      const result = await f.tasks.control({ action: 'status', taskId: row.taskId }, f.caller);
      assert.equal(result.code, 'task_state_invalid'); assert.equal(JSON.stringify(result).includes('private-field'), false);
    }
    const value = structuredClone(original);
    value.summary.sourceDiagnostic = { sourceFailures: [{ source: 'app', code: 'PRIVATE_CODE', message: 'private-field' }] };
    await writeFile(path, JSON.stringify(value));
    const result = await f.tasks.control({ action: 'status', taskId: row.taskId }, f.caller);
    assert.equal(result.code, 'task_state_invalid'); assert.doesNotMatch(JSON.stringify(result), /private-field|PRIVATE_CODE/);
  } finally { await f.cleanup(); }
});

test('an old pending control cannot stop a new run or permanently block its controls', async () => {
  const f = await fixture();
  try {
    const row = await f.tasks.download({ seriesIds: ['123'] }, f.caller);
    const store = new TaskStore(f.cwd, f.config), oldRun = row.runId, newRun = 'hgr-' + 'a'.repeat(32);
    await writeFile(join(store.directory, row.taskId + '.control.json'), JSON.stringify({ version: 1, taskId: row.taskId,
      runId: oldRun, requestId: 'old-control', action: 'pause', state: 'pending' }));
    const current = await store.change(row.taskId, task => { task.state = 'running'; task.runId = newRun; return task; });
    const request = await store.submitControl(current, { runId: newRun, requestId: 'current-control', action: 'cancel' });
    assert.equal(request.runId, newRun); assert.equal(request.requestId, 'current-control');
  } finally { await f.cleanup(); }
});

test('background Jobs admission failure starts no acquisition and retains an interrupted record', async () => {
  const f = await fixture(), session = sessionDependencies(f);
  session.jobs.start = () => { throw new Error('controller unavailable'); };
  try {
    const result = await session.tasks.download({ seriesIds: ['123'], mode: 'background' }, session.caller,
      { callId: 'child', rootCallId: 'root' });
    assert.equal(result.ok, false); assert.equal(f.calls(), 0);
    const rows = (await session.tasks.control({ action: 'list' }, session.caller)).tasks;
    assert.equal(rows[0].state, 'interrupted');
  } finally { await session.tasks.dispose(); await f.cleanup(); }
});

test('observer rejection becomes a visible task failure and never a completed receipt', async () => {
  const f = await fixture(async ({ observer }) => {
    await observer.onProgress({ retainedEpisodeCount: 1, remainingEpisodeCount: 1, requestedQuality: '720p' });
    return { ok: true, complete: true };
  });
  try {
    const result = await f.tasks.download({ seriesIds: ['123'] }, f.caller, { onProgress() { throw new Error('consumer failed'); } });
    assert.equal(result.ok, false); assert.equal(result.state, 'failed');
  } finally { await f.cleanup(); }
});

test('a failed final record write cannot return download success', async () => {
  const f = await fixture(async () => {
    const folder = join(f.cwd, f.config.taskDirectory);
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(folder)) if (/^hgt-[a-f0-9]{32}\.json$/.test(name)) await rm(join(folder, name));
    return { ok: true, complete: true };
  });
  try {
    const result = await f.tasks.download({ seriesIds: ['123'] }, f.caller);
    assert.equal(result.ok, false); assert.equal(f.tasks.activeRuns.size, 0);
  } finally { await f.cleanup(); }
});

test('unknown media cleanup outranks an independent control-reader failure', async t => {
  const observed = defer(); let inject = false;
  const originalControl = TaskStore.prototype.control;
  t.mock.method(TaskStore.prototype, 'control', async function (id) {
    if (inject) { observed.resolve(); throw new Error('control reader failed'); }
    return originalControl.call(this, id);
  });
  const f = await fixture(async () => {
    const folder = join(f.cwd, f.config.taskDirectory);
    const { readdir } = await import('node:fs/promises');
    const name = (await readdir(folder)).find(name => /^hgt-[a-f0-9]{32}\.json$/.test(name));
    assert.ok(name); inject = true;
    await observed.promise;
    return { ok: false, code: 'cleanup_unconfirmed', cleanupPendingPath: '/retained/native-stage' };
  });
  try {
    const result = await f.tasks.download({ seriesIds: ['123'] }, f.caller);
    assert.equal(result.ok, false);
    const store = new TaskStore(f.cwd, f.config), row = (await store.list())[0];
    assert.equal(row.state, 'blocked'); assert.equal(row.summary.code, 'cleanup_unconfirmed');
    assert.equal(row.summary.cleanupPendingPath, '/retained/native-stage');
  } finally { await f.cleanup(); }
});

test('a stale Agent cannot control tasks using a matching Session ID', async () => {
  const f = await fixture(), session = sessionDependencies(f);
  try {
    const impostor = { ...session.agent };
    const result = await session.tasks.control({ action: 'list' }, { kind: 'session', agent: impostor });
    assert.equal(result.code, 'task_forbidden');
  } finally { await session.tasks.dispose(); await f.cleanup(); }
});


test('read-only status and list leave stale task bytes and directory entries unchanged', async () => {
  const { readdir } = await import('node:fs/promises');
  const f = await fixture();
  try {
    const result = await f.tasks.download({ seriesIds: ['123'] }, f.caller);
    const store = new TaskStore(f.cwd, f.config);
    await store.change(result.taskId, current => { current.state = 'running'; current.runnerPid = 2147483647; return current; });
    const names = (await readdir(store.directory)).sort();
    const before = await Promise.all(names.map(name => readFile(join(store.directory, name))));
    const readonly = { ...f.caller, policy: { mode: 'read-only' } };
    assert.equal((await f.tasks.control({ action: 'status', taskId: result.taskId }, readonly)).state, 'running');
    assert.equal((await f.tasks.control({ action: 'list' }, readonly)).tasks[0].state, 'running');
    assert.deepEqual((await readdir(store.directory)).sort(), names);
    assert.deepEqual(await Promise.all(names.map(name => readFile(join(store.directory, name)))), before);
  } finally { await f.cleanup(); }
});

test('failed Jobs admission state writes still release the run and detach the tool signal', async t => {
  const f = await fixture(), session = sessionDependencies(f);
  session.jobs.start = () => { throw new Error('job controller unavailable'); };
  const original = TaskStore.prototype.change;
  t.mock.method(TaskStore.prototype, 'change', async function (id, change) {
    const current = await this.read(id);
    if (current !== null) throw new Error('state storage unavailable');
    return original.call(this, id, change);
  });
  const controller = new AbortController();
  try {
    const result = await session.tasks.download({ seriesIds: ['123'], mode: 'background' }, session.caller,
      { signal: controller.signal, callId: 'admission-child', rootCallId: 'admission-root' });
    assert.equal(result.ok, false); assert.equal(session.tasks.activeRuns.size, 0); assert.equal(f.calls(), 0);
    const { readdir } = await import('node:fs/promises');
    assert.equal((await readdir(join(f.cwd, f.config.taskDirectory))).some(name => name.endsWith('.run.lock')), false);
    controller.abort();
  } finally { await session.tasks.dispose(); await f.cleanup(); }
});


test('read-only remove preserves all task records and denies before metadata mutation', async () => {
  const { readdir } = await import('node:fs/promises');
  const f = await fixture();
  try {
    const result = await f.tasks.download({ seriesIds: ['123'] }, f.caller);
    const folder = join(f.cwd, f.config.taskDirectory), names = (await readdir(folder)).sort();
    const bytes = await Promise.all(names.map(name => readFile(join(folder, name))));
    const denied = await f.tasks.control({ action: 'remove', taskId: result.taskId }, { ...f.caller, policy: { mode: 'read-only' } });
    assert.equal(denied.code, 'file_access_denied');
    assert.deepEqual((await readdir(folder)).sort(), names);
    assert.deepEqual(await Promise.all(names.map(name => readFile(join(folder, name)))), bytes);
    await mkdir(join(f.cwd, 'not-the-workspace'));
    const outside = await f.tasks.control({ action: 'remove', taskId: result.taskId },
      { ...f.caller, policy: { mode: 'workspace-write', workspaceRoot: join(f.cwd, 'not-the-workspace') } });
    assert.equal(outside.code, 'file_access_denied');
    assert.deepEqual(await Promise.all(names.map(name => readFile(join(folder, name)))), bytes);
  } finally { await f.cleanup(); }
});
