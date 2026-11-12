/** Session-owned download tasks; persistent records never authorize a different workspace or a newer run. */
import { randomUUID, createHash } from 'node:crypto';
import { realpath, lstat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { resolveConfig } from './config.js';
import { safeError } from './errors.js';
import { pendingMediaProcess } from './media-ownership.js';
import { TaskStore, taskError, validTaskId, validRunId } from './task-store.js';
const activeStates = ['queued', 'running'];
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };
const identity = () => randomUUID().replaceAll('-', '');
const ownerKey = owner => `${owner.kind}:${owner.id}`;
const deferred = () => { let resolve, reject; const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; }); return { promise, resolve, reject }; };
const envelope = task => ({ id: task.id, taskId: task.id, kind: 'download', runId: task.runId, jobId: task.jobId,
  state: task.state, owner: { kind: task.owner.kind, id: task.owner.id }, cwd: task.cwd,
  request: { seriesIds: [...task.request.seriesIds], sourceMode: task.request.sourceMode, quality: task.request.quality,
    outputDir: task.request.outputDir, ...(task.request.episodes ? { episodes: [...task.request.episodes] } : {}) },
  progress: task.progress === null ? null : { recordedCompletedEpisodeCount: task.progress.recordedCompletedEpisodeCount,
    remainingEpisodeCount: task.progress.remainingEpisodeCount, requestedQuality: task.progress.requestedQuality },
  summary: task.summary === null ? null : { ok: task.summary.ok, ...(task.summary.complete !== undefined ? { complete: task.summary.complete } : {}),
    ...(task.summary.code ? { code: task.summary.code } : {}), ...(task.summary.path ? { path: task.summary.path } : {}),
    ...(task.summary.cleanupPendingPath ? { cleanupPendingPath: task.summary.cleanupPendingPath } : {}) },
  createdAt: task.createdAt, updatedAt: task.updatedAt });
const wrapped = task => ({ ok: true, taskId: task.id, runId: task.runId, jobId: task.jobId, state: task.state,
  downloadTask: envelope(task), task: envelope(task) });
const locked = error => typeof error?.message === 'string' && error.message.startsWith('atomic-write: timed out waiting for the writer lock');

/** One plugin instance owns its active operations; the canonical workspace contains shared durable records. */
export class HongguoTasks {
  constructor(config, dependencies) {
    this.config = resolveConfig(config); this.client = dependencies.client; this.jobs = dependencies.jobs;
    this.agents = dependencies.agents; this.resolvePolicy = dependencies.resolvePolicy;
    this.activeRuns = new Map(); this.admissions = new Set(); this.controls = new Set(); this.lifetime = new AbortController(); this.closing = false;
  }
  async caller(caller, write = false, newTask = false) {
    let owner, cwd, policy;
    if (caller?.kind === 'session') {
      const agent = caller.agent;
      if (!agent || this.agents?.get(agent.id) !== agent || agent.session.id !== agent.id) throw taskError('task_forbidden', '下载任务需要原会话中的活动 Agent');
      owner = { kind: 'session', id: agent.session.id }; cwd = await realpath(agent.session.header.cwd);
      policy = this.resolvePolicy?.(agent);
    } else if (caller?.kind === 'cli' && typeof caller.operatorId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(caller.operatorId)) {
      owner = !newTask && caller.selectedOwnerSessionId !== undefined
        ? { kind: 'session', id: caller.selectedOwnerSessionId } : { kind: 'cli', id: caller.operatorId };
      cwd = await realpath(caller.cwd); policy = caller.policy;
    } else throw taskError('task_forbidden', '下载任务调用者无效');
    if (typeof owner.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(owner.id)
      || !(await lstat(cwd)).isDirectory() || !policy || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)) {
      throw taskError('task_forbidden', '下载任务需要明确的工作区和文件权限');
    }
    if (write && policy.mode === 'read-only') throw taskError('file_access_denied', '当前文件权限为只读，未启动下载');
    if (write && policy.mode === 'workspace-write' && (!policy.workspaceRoot || !inside(await realpath(policy.workspaceRoot), cwd))) {
      throw taskError('file_access_denied', '当前工作区不在允许写入的目录中');
    }
    return { owner, cwd, policy, caller, store: new TaskStore(cwd, this.config) };
  }
  async read(context, id, inspect = true) {
    if (!validTaskId(id)) throw taskError('task_invalid', '下载任务 ID 无效');
    let task = await context.store.read(id);
    if (!task || ownerKey(task.owner) !== ownerKey(context.owner)) throw taskError('task_forbidden', '此任务不属于当前会话或所选本地任务所有者');
    if (inspect && context.policy.mode !== 'read-only' && activeStates.includes(task.state)) {
      try {
        task = await withFileLock(context.store.runPath(id), async () => {
          const latest = await context.store.read(id);
          if (latest.runId !== task.runId || !activeStates.includes(latest.state)) return latest;
          const pending = await pendingMediaProcess(latest.checkpointDirectory);
          return context.store.change(id, current => {
            if (current.runId !== latest.runId || !activeStates.includes(current.state)) return null;
            current.state = pending ? 'blocked' : 'interrupted';
            current.summary = { ok: false, code: pending ? 'cleanup_unconfirmed' : 'task_interrupted',
              ...(pending ? { cleanupPendingPath: pending } : {}) }; return current;
          });
        }, { waitMs: 0 });
      } catch (error) { if (!locked(error)) throw error; }
    }
    return task;
  }
  download(args, caller, exec = {}) {
    const work = this.downloadRequest(args, caller, exec);
    this.admissions.add(work);
    void work.then(() => this.admissions.delete(work), () => this.admissions.delete(work));
    return work.catch(error => ({ ok: false, complete: false, ...safeError(error) }));
  }
  async downloadRequest(args, caller, exec) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || args.mode !== undefined && !['wait', 'background'].includes(args.mode)) throw taskError('invalid_arguments', 'mode 必须为 wait 或 background');
    const { mode = 'wait', ...selection } = args;
    const context = await this.caller(caller, true, true);
    if (this.closing) throw taskError('task_unloading', '红果任务管理正在停止');
    if (mode === 'background' && (caller.kind !== 'session' || !this.jobs)) throw taskError('task_jobs_unavailable', '后台下载需要会话中的 Jobs 服务；CLI 请使用前台等待');
    exec.signal?.throwIfAborted();
    if (caller.kind === 'session' && (typeof exec.callId !== 'string' || !exec.callId || typeof exec.rootCallId !== 'string' || !exec.rootCallId)) throw taskError('task_call_required', '会话下载需要已记录的工具调用 ID');
    const spec = await this.client.resolveTaskRequest(selection, context.cwd, context.policy);
    const callId = exec.callId ?? randomUUID();
    const id = `hgt-${createHash('sha256').update(`${ownerKey(context.owner)}\0${context.cwd}\0${callId}`).digest('hex').slice(0, 32)}`;
    const existing = await context.store.read(id);
    if (existing) {
      if (ownerKey(existing.owner) !== ownerKey(context.owner) || JSON.stringify(existing.request) !== JSON.stringify(spec.request)
        || existing.sourceIdentity !== spec.sourceIdentity) throw taskError('task_call_conflict', '此工具调用已使用其他下载参数');
      return wrapped(await this.read(context, id));
    }
    const held = await this.acquire(context, id, exec.signal);
    let transferred = false;
    try {
    const accepted = await context.store.accept(id, () => ({ version: 1, kind: 'download', id, owner: context.owner, cwd: context.cwd,
      request: spec.request, sourceIdentity: spec.sourceIdentity, checkpointDirectory: spec.checkpointDirectory,
      state: 'queued', revision: 0, runId: null, runnerPid: null, jobId: null, progress: null, summary: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    if (!accepted.created) return wrapped(await context.store.read(id));
    transferred = true;
    return await this.launch(accepted.task, context, mode, exec, held);
    } finally { if (!transferred) { held.release.resolve(); await held.lease; } }
  }
  async acquire(context, id, signal) {
    await context.store.ready(true);
    const acquired = deferred(), release = deferred();
    const lease = withFileLock(context.store.runPath(id), async () => { acquired.resolve(); await release.promise; }, { waitMs: 0, signal });
    try { await Promise.race([acquired.promise, lease]); }
    catch (error) { if (locked(error)) throw taskError('task_locked', '另一运行者仍持有此下载任务'); throw error; }
    return { lease, release };
  }
  async launch(task, context, mode, exec = {}, held) {
    if (this.closing || this.activeRuns.has(task.id) || exec.signal?.aborted) {
      if (held) { held.release.resolve(); await held.lease; }
      if (exec.signal?.aborted) throw exec.signal.reason;
      throw taskError('task_locked', '任务正在运行或插件正在停止');
    }
    const { lease, release } = held ?? await this.acquire(context, task.id, exec.signal);
    const admission = deferred(), started = deferred();
    const run = { id: `hgr-${identity()}`, taskId: task.id, controller: new AbortController(), stop: null,
      poll: new AbortController(), jobId: null, done: null, started, release, lease, admission, context, exec, mode };
    const abort = () => { run.stop = 'cancelled'; run.controller.abort(); };
    exec.signal?.addEventListener('abort', abort, { once: true });
    run.detach = () => exec.signal?.removeEventListener('abort', abort);
    if (exec.signal?.aborted) abort();
    this.activeRuns.set(task.id, run);
    try {
      const start = job => {
        run.jobId = job?.id ?? null; run.job = job;
        run.done = this.execute(task, run);
        return { cancel: reason => { run.stop = /owner|dispos|unload|teardown/i.test(reason ?? '') ? 'interrupted' : 'cancelled'; run.controller.abort(); },
          done: run.done.then(value => ({ status: value.ok ? 'completed' : run.stop ? 'killed' : 'failed', result: JSON.stringify(value) }),
            () => ({ status: 'failed', detail: 'Download task state could not be committed; inspect its private record' })) };
      };
      if (mode === 'background' && context.caller.kind === 'session' && this.jobs) {
        this.jobs.start({ kind: 'hongguo-download', owner: context.owner.id, label: 'Hongguo download',
          ...(exec.callId ? { toolCall: { callId: exec.callId, rootCallId: exec.rootCallId } } : {}), run: start });
      } else start(null);
      admission.resolve();
      const admitted = await started.promise;
      if (mode === 'background') return wrapped(admitted);
      return await run.done;
    } catch (error) {
      admission.resolve(); run.controller.abort();
      if (run.done) await Promise.allSettled([run.done]);
      else {
        try {
          release.resolve(); await lease;
          await context.store.change(task.id, current => { current.state = 'interrupted'; current.summary = { ok: false, code: 'task_admission_failed' }; return current; });
        } finally { this.activeRuns.delete(task.id); run.detach(); }
      }
      throw error;
    }
  }
  async poll(run) {
    while (!run.poll.signal.aborted) {
      const request = await run.context.store.control(run.taskId);
      if (request?.state === 'pending') {
        if (request.runId === run.id) { run.stop = request.action === 'pause' ? 'paused' : 'cancelled'; run.controller.abort(); }
        else await run.context.store.acknowledge(run.taskId, request.runId, 'rejected');
      }
      try { await delay(this.config.taskPollIntervalMs, undefined, { signal: run.poll.signal }); }
      catch (error) { if (!run.poll.signal.aborted) throw error; }
    }
  }
  async execute(task, run) {
    const store = run.context.store;
    let polling, result, published = false;
    try {
      await run.admission.promise;
      run.controller.signal.throwIfAborted();
      const live = await this.caller(run.context.caller, true, true);
      if (live.cwd !== task.cwd || (run.context.caller.kind === 'session' && ownerKey(live.owner) !== ownerKey(task.owner))) {
        throw taskError('task_workspace_changed', '下载任务所有者或工作区已变化');
      }
      const checked = await this.client.resolveTaskRequest(task.request, task.cwd, live.policy);
      if (checked.sourceIdentity !== task.sourceIdentity || JSON.stringify(checked.request) !== JSON.stringify(task.request)) {
        throw taskError('task_source_changed', '下载来源或目录已变化，原任务未执行');
      }
      const prior = await store.control(task.id);
      if (prior?.state === 'pending' && prior.runId !== run.id) await store.acknowledge(task.id, prior.runId, 'rejected');
      task = await store.change(task.id, current => {
        if (current.runId !== task.runId || current.state === 'blocked') throw taskError('task_stale_run', '下载任务运行代次已变化');
        current.runId = run.id; current.runnerPid = process.pid; current.jobId = run.jobId; current.state = 'running'; current.summary = null; return current;
      });
      if (run.mode === 'background') run.detach();
      run.controller.signal.throwIfAborted(); run.started.resolve(task);
      polling = this.poll(run).catch(error => { run.pollError = error; run.controller.abort(); });
      result = await this.client.download(task.request, run.controller.signal, task.cwd, live.policy, {
        onProgress: async progress => {
          await store.change(task.id, current => {
            if (current.runId !== run.id || current.state !== 'running') throw taskError('task_stale_run', '下载任务运行代次已变化');
            current.progress = { recordedCompletedEpisodeCount: progress.retainedEpisodeCount,
              remainingEpisodeCount: progress.remainingEpisodeCount, requestedQuality: progress.requestedQuality };
            return current;
          });
          run.job?.updateProgress(`${progress.retainedEpisodeCount} completed, ${progress.remainingEpisodeCount} remaining`);
          await run.exec.onProgress?.(progress);
        },
      });
      if (run.pollError && result.code !== 'cleanup_unconfirmed') throw run.pollError;
      task = await store.change(task.id, current => {
        if (current.runId !== run.id) throw taskError('task_stale_run', '下载任务运行代次已变化');
        current.state = result.code === 'cleanup_unconfirmed' ? 'blocked' : run.stop ?? (result.ok ? 'completed' : 'failed');
        current.summary = { ok: result.ok, complete: result.complete === true,
          ...(result.code ? { code: result.code } : {}), ...(result.path ? { path: result.path } : {}),
          ...(result.cleanupPendingPath ? { cleanupPendingPath: result.cleanupPendingPath } : {}) };
        return current;
      });
      published = true;
      return { ...result, ...wrapped(task), ok: result.ok, complete: result.complete === true };
    } catch (error) {
      run.controller.abort(); run.started.reject(error);
      task = await store.change(task.id, current => {
        if (current.runId !== null && current.runId !== run.id) throw taskError('task_stale_run', '下载任务运行代次已变化');
        const unknown = result?.code === 'cleanup_unconfirmed' || error.code === 'cleanup_unconfirmed';
        current.state = unknown ? 'blocked' : 'failed';
        current.summary = { ok: false, code: unknown ? 'cleanup_unconfirmed' : safeError(error).code,
          ...(result?.cleanupPendingPath ? { cleanupPendingPath: result.cleanupPendingPath } : {}) }; return current;
      });
      published = true;
      return { ...wrapped(task), ok: false, complete: false, ...safeError(error) };
    } finally {
      run.poll.abort(); await polling;
      run.detach(); run.release.resolve();
      try { await run.lease; }
      finally {
        try { if (published) await store.acknowledge(task.id, run.id, task.state === 'blocked' ? 'rejected' : 'acknowledged'); }
        finally { this.activeRuns.delete(task.id); }
      }
    }
  }
  async control(args, caller, signal, execMeta = {}) {
    const active = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const work = this.controlRequest(args, caller, active, execMeta);
    this.controls.add(work);
    try { return await work; }
    catch (error) { return { ok: false, ...(locked(error) ? { code: 'task_locked', message: '另一运行者仍持有此下载任务' } : safeError(error)) }; }
    finally { this.controls.delete(work); }
  }
  async controlRequest(args, caller, signal, execMeta) {
    const actions = ['list', 'status', 'pause', 'resume', 'cancel', 'retry', 'remove'];
    if (!args || typeof args !== 'object' || Object.keys(args).some(key => !['action', 'taskId', 'expectedRunId', 'requestId', 'mode'].includes(key))
      || !actions.includes(args.action) || (args.action === 'list') !== (args.taskId === undefined)) throw taskError('task_invalid', '下载任务控制参数无效');
    const context = await this.caller(caller, ['resume', 'retry', 'remove'].includes(args.action));
    signal?.throwIfAborted();
    if (args.action === 'list') {
      const rows = (await context.store.list()).filter(task => ownerKey(task.owner) === ownerKey(context.owner));
      const tasks = [];
      for (const item of rows) tasks.push(envelope(await this.read(context, item.id)));
      return { ok: true, tasks };
    }
    let task = await this.read(context, args.taskId);
    if (args.action === 'status') return wrapped(task);
    if (args.action === 'remove') {
      await withFileLock(context.store.runPath(task.id), async () => {
        const pending = await pendingMediaProcess(task.checkpointDirectory);
        if (pending) throw taskError('cleanup_unconfirmed', '视频清理未确认，不能移除任务记录');
        await context.store.remove(task.id);
      }, { waitMs: 0, signal });
      return { ok: true, taskId: task.id, removed: true, mediaPreserved: true };
    }
    if (['resume', 'retry'].includes(args.action)) {
      if (this.closing) throw taskError('task_unloading', '红果任务管理正在停止');
      if (task.state === 'completed') return wrapped(task);
      if (task.state === 'blocked' || activeStates.includes(task.state)) throw taskError('task_locked', '任务仍在运行或视频清理未确认');
      const spec = await this.client.resolveTaskRequest(task.request, task.cwd, context.policy);
      if (spec.sourceIdentity !== task.sourceIdentity || JSON.stringify(spec.request) !== JSON.stringify(task.request)) throw taskError('task_source_changed', '下载来源或目录已变化，原任务未恢复');
      const mode = args.mode ?? (caller.kind === 'cli' ? 'wait' : 'background');
      if (!['wait', 'background'].includes(mode) || mode === 'background' && (caller.kind !== 'session' || !this.jobs)) throw taskError('task_jobs_unavailable', '后台下载需要会话中的 Jobs 服务');
      if (caller.kind === 'session' && (!execMeta.callId || !execMeta.rootCallId)) throw taskError('task_call_required', '恢复任务需要已记录的工具调用 ID');
      return this.launch(task, context, mode, { ...execMeta, signal });
    }
    if (!validRunId(args.expectedRunId) || task.runId !== args.expectedRunId) throw taskError('task_stale_run', '请使用状态查询返回的运行代次');
    if (!activeStates.includes(task.state)) return { ...wrapped(task), control: { state: 'rejected', runId: task.runId, requestId: args.requestId ?? null } };
    const requestId = args.requestId ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(requestId)) throw taskError('task_invalid', '控制请求 ID 无效');
    await context.store.submitControl(task, { runId: args.expectedRunId, requestId, action: args.action });
    const active = this.activeRuns.get(task.id);
    if (active?.id === args.expectedRunId) { active.stop = args.action === 'pause' ? 'paused' : 'cancelled'; active.controller.abort(); }
    const until = Date.now() + this.config.taskControlWaitMs;
    for (;;) {
      const request = await context.store.control(task.id);
      if (request?.requestId === requestId && request.state !== 'pending') {
        task = await this.read(context, task.id);
        return { ...wrapped(task), control: { state: request.state, requestId, runId: request.runId } };
      }
      if (Date.now() >= until) return { ...wrapped(await this.read(context, task.id)), control: { state: 'pending', requestId, runId: args.expectedRunId } };
      await delay(this.config.taskPollIntervalMs, undefined, { signal });
    }
  }
  /** Stop admission and await owned downloads, process cleanup and state publication. */
  async dispose() {
    this.closing = true; this.lifetime.abort();
    for (const run of this.activeRuns.values()) { run.stop = 'interrupted'; run.controller.abort(); }
    await Promise.allSettled([...this.admissions]);
    const results = await Promise.allSettled([...this.activeRuns.values()].map(run => run.done).filter(Boolean));
    await Promise.allSettled([...this.controls]);
    if (results.some(result => result.status === 'rejected')) throw taskError('task_state_uncommitted', '下载任务已停止，但状态记录未确认，请检查私有记录');
  }
}
