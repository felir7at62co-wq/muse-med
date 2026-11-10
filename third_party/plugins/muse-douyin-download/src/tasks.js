/** Durable selected-video batches. Jobs observe each runner; private task IDs survive jobs and Host restarts. */
import { realpath, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import { TaskStore, activeRuns, digest, taskError } from './task-store.js';
import { nativeEvidence, receiptFields, stableReceipt } from './receipt.js';
import { withNetworkGuidance } from './network-guidance.js';

const INSIDE = (root, file) => { const path = relative(root, file); return path === '' || path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path); };
const idOf = source => /^https:\/\/www\.douyin\.com\/video\/(\d{10,25})$/.exec(source ?? '')?.[1] ?? null;
const envelope = task => ({ id: task.id, state: task.state, jobId: task.jobId });
const timestamp = now => new Date(now()).toISOString();
const failureCode = (error, fallback) => typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : fallback;
const admission = { tail: Promise.resolve() };
const acceptances = new Map();
const jobRegistries = new WeakMap();
const publicTask = task => { const { jobRegistryInstance, ...visible } = task; return visible; };
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function selected(value) {
  const url = new URL(value);
  const video = /^\/(?:share\/)?video\/(\d{10,25})\/?$/.exec(url.pathname)?.[1];
  const modal = url.searchParams.getAll('modal_id');
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !['v.douyin.com', 'www.douyin.com', 'www.iesdouyin.com'].includes(url.hostname)) throw taskError('DOUYIN_TASK_INVALID', 'A selected official HTTPS video or share link is required');
  if (url.hostname === 'v.douyin.com' && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return `https://v.douyin.com${url.pathname}`;
  if (modal.length > 1 || video && modal.length && modal[0] !== video) throw taskError('DOUYIN_TASK_INVALID', 'Douyin video identity is ambiguous');
  const id = video ?? (modal.length === 1 && /^\d{10,25}$/.test(modal[0]) ? modal[0] : null);
  if (!id) throw taskError('DOUYIN_TASK_INVALID', 'A specific Douyin video must be selected');
  return `https://www.douyin.com/video/${id}`;
}
function blocked(result) {
  const raw = typeof result?.message === 'string' ? result.message : '';
  const code = typeof result?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(result.code) ? result.code
    : /LOGIN_OR_VERIFICATION_REQUIRED|ACCESS_RESTRICTED/.exec(raw)?.[0] ?? 'SOURCE_UNAVAILABLE';
  return withNetworkGuidance({ status: 'blocked', code, message: raw && raw.length <= 2048 && !/https?:\/\/|cookie|bearer|token=|signature/i.test(raw) ? raw : 'The selected official source requires attention before downloading can continue' });
}

/** One scoped controller; its private registry and leases cooperate with other controllers and processes. */
export class DouyinTasks {
  /** @param ctx Agents, jobs and sandbox policy services. @param settings Resolved deployment settings. @param dependencies Existing verified media acquisition and optional clock. */
  constructor(ctx, settings, dependencies) {
    this.ctx = ctx; this.settings = settings; this.acquireVideo = dependencies.acquireVideo; this.now = dependencies.now ?? Date.now;
    this.store = new TaskStore(settings); this.running = new Set(); this.admitting = new Set(); this.closing = false;
  }

  /** @returns Initialization without replaying persisted downloads. */
  ready() {
    const jobs = this.service('jobs');
    if (jobs && !jobRegistries.has(jobs)) jobRegistries.set(jobs, randomUUID());
    this.store.jobRegistryInstance = jobs ? jobRegistries.get(jobs) : undefined;
    return this.store.ready();
  }
  /** @param name Host service key. @returns The current service instance rather than a persisted reference. */
  service(name) { return typeof this.ctx.get === 'function' ? this.ctx.get(name) : this.ctx[name]; }

  /** @param agent Exact live caller. @param write Whether the operation can write workspace media. @returns Canonical workspace and owner identity, rejecting stale agents and read-only policy before network. */
  async caller(agent, write = false) {
    if (!agent || this.ctx.agents.get(agent.id) !== agent || agent.session.id !== agent.id) throw taskError('DOUYIN_TASK_FORBIDDEN', 'Download tasks require the exact live initiating agent');
    const cwd = await realpath(agent.session.header.cwd);
    if (!(await lstat(cwd)).isDirectory()) throw taskError('DOUYIN_TASK_INVALID', 'Download workspace must be a real directory');
    const policy = this.service('sandboxPolicy')?.resolve({ session: agent.session });
    if (!policy) throw taskError('DOUYIN_TASK_INVALID', 'Persistent downloads require sandboxPolicy');
    if (write && policy.mode === 'read-only') throw taskError('DOUYIN_READ_ONLY', 'Downloads are denied by the current read-only file policy; no network operation started');
    if (write && policy.mode === 'workspace-write' && !INSIDE(await realpath(policy.workspaceRoot), cwd)) throw taskError('DOUYIN_READ_ONLY', 'Download workspace is outside the current writable root');
    return { ownerSessionId: agent.session.id, cwd };
  }

  /** @param id Durable ID. @param owner Actual caller identity/workspace. @returns Only an owned same-workspace task. */
  async readTask(id, owner) {
    if (typeof id !== 'string' || !/^dyt-[a-f0-9]{32}$/.test(id)) throw taskError('DOUYIN_TASK_INVALID', 'Invalid durable download taskId');
    const task = (await this.store.read()).tasks.find(task => task.id === id);
    if (!task || task.ownerSessionId !== owner.ownerSessionId) throw taskError('DOUYIN_TASK_FORBIDDEN', 'Download task is unavailable to this Session');
    if (task.cwd !== owner.cwd) throw taskError('DOUYIN_TASK_FORBIDDEN', 'Download task workspace differs from the current Session');
    return task;
  }

  /** @param id Durable ID. @param ownerSessionId Original Session. @param change Locked mutation. @returns Atomically committed task state with a newer revision. */
  async update(id, ownerSessionId, change) {
    return this.store.transaction(registry => {
      const task = registry.tasks.find(task => task.id === id && task.ownerSessionId === ownerSessionId);
      if (!task) throw taskError('DOUYIN_TASK_FORBIDDEN', 'Download task is unavailable to this Session');
      change(task); task.revision++; task.updatedAt = timestamp(this.now);
      return task;
    });
  }

  /** @param task Persisted task. @param item Selected item. @param result Acquisition receipt. @param signal Hash cancellation. @returns Credential-free verified receipt after actual bytes, paths and recorded identity match. */
  async verify(task, item, result, signal) {
    try { return await this.verifyFile(task, item, result, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      if (error.code === 'DOUYIN_RECEIPT_INVALID') throw error;
      throw taskError('DOUYIN_RECEIPT_INVALID', 'The video or source receipt could not be read and verified');
    }
  }

  /** @param task Original task/workspace. @param item Immutable selection. @param result Decoded-file receipt. @param signal Cancels bounded hashing. @returns Safe receipt fields after byte/hash/source-file checks. */
  async verifyFile(task, item, result, signal) {
    if (result?.status !== 'downloaded' || result.full_decode_verified !== true || !Number.isSafeInteger(result.bytes) || result.bytes < 1 || result.bytes > this.settings.maxDownloadBytes || !/^[a-f0-9]{64}$/.test(result.sha256 ?? '') || typeof result.duration_seconds !== 'number' || !Number.isFinite(result.duration_seconds) || result.duration_seconds <= 0 || !isAbsolute(result.path ?? '') || result.receipt !== result.path + '.source.json') throw taskError('DOUYIN_RECEIPT_INVALID', 'Video acquisition did not return a verified file receipt');
    const id = idOf(result.source);
    if (!id || item.videoId && item.videoId !== id || idOf(item.url) && idOf(item.url) !== id || result.targetVideoId !== undefined && result.targetVideoId !== id) throw taskError('DOUYIN_RECEIPT_INVALID', 'Downloaded video identity differs from the selected or previously resolved video');
    const file = await realpath(result.path), receiptPath = await realpath(result.receipt);
    const directory = await realpath(join(task.cwd, 'source', 'media', 'douyin'));
    if (!INSIDE(task.cwd, directory) || !INSIDE(directory, file) || !INSIDE(directory, receiptPath) || receiptPath !== file + '.source.json') throw taskError('DOUYIN_RECEIPT_INVALID', 'Download receipt escapes the task workspace');
    const info = await lstat(result.path), receiptInfo = await lstat(result.receipt);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== result.bytes || !receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.size > this.settings.taskReceiptMaxBytes) throw taskError('DOUYIN_RECEIPT_INVALID', 'Downloaded file or receipt is missing, changed or oversized');
    signal?.throwIfAborted();
    const hash = createHash('sha256');
    let hashedBytes = 0;
    for await (const chunk of createReadStream(file, { signal, end: result.bytes })) {
      hashedBytes += chunk.length;
      if (hashedBytes > result.bytes || hashedBytes > this.settings.maxDownloadBytes) throw taskError('DOUYIN_RECEIPT_INVALID', 'Downloaded video grew beyond its verified byte count while hashing');
      hash.update(chunk);
    }
    if (hashedBytes !== result.bytes || hash.digest('hex') !== result.sha256) throw taskError('DOUYIN_RECEIPT_INVALID', 'Downloaded video hash or byte count differs from its verified receipt');
    let recorded;
    try { recorded = JSON.parse((await this.store.readBounded(receiptPath, this.settings.taskReceiptMaxBytes)).toString('utf8')); }
    catch (error) { throw taskError('DOUYIN_RECEIPT_INVALID', 'Video source receipt is not valid JSON'); }
    for (const field of ['path', 'source', 'bytes', 'sha256', 'duration_seconds', 'full_decode_verified', 'taskId', 'targetVideoId']) if (result[field] !== undefined && recorded[field] !== result[field]) throw taskError('DOUYIN_RECEIPT_INVALID', `Video source receipt differs in ${field}`);
    if (result.evidence !== undefined) {
      nativeEvidence(result.evidence, id, this.settings.taskReceiptMaxBytes);
      nativeEvidence(recorded.evidence, id, this.settings.taskReceiptMaxBytes);
      if (stableReceipt(recorded.evidence) !== stableReceipt(result.evidence)) throw taskError('DOUYIN_RECEIPT_INVALID', 'Native download evidence differs from its source receipt');
    }
    const after = await lstat(file);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) throw taskError('DOUYIN_RECEIPT_INVALID', 'Video changed while its receipt was verified');
    return Object.fromEntries(receiptFields.filter(field => result[field] !== undefined).map(field => [field, result[field]]));
  }

  /** @param task Final state, including optional transient unregistered receipts. @returns Existing wait fields plus the separate durable task envelope. */
  summary(task) {
    const items = task.items.map(item => item.result ?? { status: 'blocked', code: item.error?.code ?? 'INTERRUPTED', message: item.error?.message ?? 'This selected video has not completed' });
    const downloaded = task.items.filter(item => item.state === 'completed').length;
    const value = task.selection.single ? items[0] : { status: downloaded === items.length ? 'complete' : downloaded ? 'partial' : 'blocked', requested: items.length, downloaded,
      uniqueVideos: new Set(task.items.filter(item => item.state === 'completed').map(item => item.videoId)).size,
      reusedSelections: task.items.filter(item => item.reused === true).length,
      items: items.map((item, index) => ({ index: index + 1, ...item, ...(task.items[index].reused ? { reused: true, ...(task.items[index].reusedFromIndex ? { reusedFromIndex: task.items[index].reusedFromIndex } : {}) } : {}) })) };
    return { ...value, downloadTask: envelope(task), ...(task.verifiedButUnrecordedReceipts?.length ? {
      status: 'partial', verifiedButUnrecordedReceipts: task.verifiedButUnrecordedReceipts,
      registrationError: task.registrationError, registryStateRecorded: task.registryStateRecorded,
    } : {}) };
  }

  /** @param run Admitted owned runner. @param agent Foreground collector. @returns Final state after Jobs settlement, suppressing duplicate completion delivery. */
  async wait(run, agent) {
    const timeout = (this.settings.timeoutMs + 2 * this.settings.nativeTimeoutMs + 390000) * this.settings.maxVideos + 10000;
    await run.jobs.wait(run.jobId, timeout, agent.id);
    return run.done;
  }

  /** @param args Validated official selection and wait/background mode. @param agent Actual initiating agent. @param exec Logged tool call identity and caller cancellation. @returns Existing compatible wait result or queued durable task receipt. */
  download(args, agent, exec) {
    const operation = this.downloadRequest(args, agent, exec);
    this.admitting.add(operation);
    void operation.then(() => this.admitting.delete(operation), () => this.admitting.delete(operation));
    return operation;
  }

  /** @param args Validated selection. @param agent Actual owner. @param exec Logged acceptance/cancellation. @returns One idempotently accepted execution; background admission owns no completed tool signal. */
  async downloadRequest(args, agent, exec) {
    const owner = await this.caller(agent, true);
    if (this.closing) throw taskError('DOUYIN_TASK_INVALID', 'Download plugin is unloading');
    exec.signal?.throwIfAborted();
    if (typeof exec.callId !== 'string' || !exec.callId) throw taskError('DOUYIN_TASK_INVALID', 'Persistent downloads require a logged tool callId');
    await this.ready();
    const urls = (args.urls ?? [args.url]).map(selected), selection = { urls, single: args.url !== undefined, publicOnly: args.publicOnly === true };
    const id = `dyt-${digest(`${owner.ownerSessionId}\0${exec.callId}`).slice(0, 32)}`;
    const acceptanceKey = digest(`${owner.ownerSessionId}\0${exec.callId}`);
    let created = false;
    let task = await this.store.transaction(registry => {
      const previous = registry.tasks.find(task => task.id === id);
      if (previous) {
        if (previous.ownerSessionId !== owner.ownerSessionId || previous.cwd !== owner.cwd || JSON.stringify(previous.selection) !== JSON.stringify(selection)) throw taskError('DOUYIN_TASK_STALE', 'This logged tool call was already accepted with a different selection');
        return previous;
      }
      created = true;
      const task = { id, schemaVersion: 1, revision: 0, ownerSessionId: owner.ownerSessionId, acceptanceKey, cwd: owner.cwd,
        selection, state: 'queued', jobId: null, createdAt: timestamp(this.now), updatedAt: timestamp(this.now),
        items: urls.map((url, index) => ({ index: index + 1, url, videoId: idOf(url), state: 'pending' })) };
      registry.tasks.push(task); return task;
    }, exec.signal);
    const key = `${this.store.directory}:${id}`;
    if (!created) {
      let active = activeRuns.get(key);
      const accepting = acceptances.get(key);
      if (args.mode === 'background' && accepting) return { status: 'queued', downloadTask: { id, state: 'queued', jobId: active?.jobId ?? task.jobId } };
      if (args.mode !== 'background' && !active && accepting) active = await accepting;
      if (['queued', 'running'].includes(task.state)) {
        if (args.mode === 'background') return { status: 'queued', downloadTask: { id, state: task.state, jobId: active?.jobId ?? task.jobId } };
        if (!active) return { status: 'queued', downloadTask: envelope(task) };
      }
      if (args.mode !== 'background' && active) task = await this.wait(active, agent);
      if (task.state === 'completed') for (const item of task.items) await this.verify(task, item, item.result, exec.signal);
      return this.summary(task);
    }
    const accepting = this.start(task, agent, args.mode === 'background', args.mode === 'background' ? undefined : exec.signal);
    acceptances.set(key, accepting);
    let run;
    try { run = await accepting; }
    finally { if (acceptances.get(key) === accepting) acceptances.delete(key); }
    if (args.mode === 'background') return { status: 'queued', downloadTask: { id, state: 'queued', jobId: run.jobId } };
    task = await this.wait(run, agent);
    return this.summary(task);
  }

  /** @param task Persisted accepted task. @param agent Exact live owner. @param background Whether native fallback must use the private task guest. @param callerSignal Foreground cancellation only. @returns One leased Jobs runner; failed admission starts no acquisition. */
  async start(task, agent, background, callerSignal) {
    if (this.closing) {
      await this.update(task.id, task.ownerSessionId, current => { current.state = 'interrupted'; current.jobId = null; });
      throw taskError('DOUYIN_TASK_INVALID', 'Download plugin is unloading; accepted task remains interrupted');
    }
    await this.caller(agent, true);
    const lease = await this.store.acquireLease(task.id), controller = new AbortController();
    if (this.closing) {
      await this.store.removeLease(task.id, lease);
      await this.update(task.id, task.ownerSessionId, current => { current.state = 'interrupted'; current.jobId = null; });
      throw taskError('DOUYIN_TASK_INVALID', 'Download plugin unloaded before runner admission');
    }
    const key = `${this.store.directory}:${task.id}`;
    const run = { controller, stopState: 'cancelled', jobId: null, done: null, pendingReceipts: [], latestTask: task, registrationError: null, registryStateRecorded: true };
    const abort = () => controller.abort(callerSignal.reason);
    if (callerSignal?.aborted) controller.abort(callerSignal.reason);
    else callerSignal?.addEventListener('abort', abort, { once: true });
    activeRuns.set(key, run);
    try {
      const jobs = this.service('jobs');
      if (!jobs) throw taskError('DOUYIN_TASK_INVALID', 'Persistent downloads require jobs and a scoped job controller');
      run.jobs = jobs;
      run.jobId = jobs.start({ kind: 'douyin-download', owner: agent.id, label: `Douyin ${task.items.length} selected video(s)`, outputLimitBytes: this.settings.taskOutputMaxBytes,
        run: job => {
          run.jobId = job.id;
          const previous = admission.tail;
          let release;
          const slot = new Promise(resolve => { release = resolve; });
          admission.tail = previous.then(() => slot);
          run.done = Promise.resolve().then(async () => {
            let acquired = false;
            try {
              run.latestTask = await this.update(task.id, task.ownerSessionId, current => { current.jobId = run.jobId; current.jobRegistryInstance = this.store.jobRegistryInstance; current.state = 'queued'; });
              await abortable(previous, controller.signal);
              acquired = true;
              controller.signal.throwIfAborted();
              await this.execute(task, agent, background, run, job);
            } catch (error) {
              run.registrationError = { code: failureCode(error, 'DOWNLOAD_INTERRUPTED'), message: 'The runner stopped; verified but unrecorded files must be inspected before retrying' };
              try {
                run.latestTask = await this.update(task.id, task.ownerSessionId, current => {
                  current.state = controller.signal.aborted ? run.stopState : 'interrupted';
                  current.error = { code: failureCode(error, 'DOWNLOAD_INTERRUPTED'), message: 'Download runner stopped before all selected videos were verified' };
                  for (const item of current.items) if (item.state === 'running') { item.state = 'interrupted'; item.error = current.error; }
                });
              } catch (stateError) {
                run.registryStateRecorded = false;
                run.registrationError = { code: failureCode(stateError, 'TASK_STATE_WRITE_FAILED'), message: 'Final task state could not be recorded; inspect the returned verified file receipts' };
              }
            } finally {
              callerSignal?.removeEventListener('abort', abort);
              try { await this.store.removeLease(task.id, lease); }
              catch (leaseError) { run.registrationError ??= { code: failureCode(leaseError, 'TASK_LEASE_CLEANUP_FAILED'), message: 'Download I/O ended but its private execution lease could not be removed' }; }
              finally {
                activeRuns.delete(key);
                if (acquired) release();
                else void previous.then(release, release);
              }
            }
            let final;
            try { final = await this.readTask(task.id, { ownerSessionId: task.ownerSessionId, cwd: task.cwd }); }
            catch (readError) { final = structuredClone(run.latestTask); run.registryStateRecorded = false; }
            if (!run.registryStateRecorded || run.pendingReceipts.length) final = { ...final, state: 'interrupted',
              verifiedButUnrecordedReceipts: [...run.pendingReceipts], registrationError: run.registrationError,
              registryStateRecorded: run.registryStateRecorded };
            return final;
          });
          this.running.add(run.done);
          void run.done.then(() => this.running.delete(run.done), () => this.running.delete(run.done));
          return { cancel: reason => {
            if (!controller.signal.aborted) { run.stopState = /owner|dispos|unload|teardown/i.test(reason ?? '') ? 'interrupted' : 'cancelled'; controller.abort(new Error('Download runner cancelled')); }
          }, done: run.done.then(current => ({
            status: current.state === 'completed' ? 'completed' : controller.signal.aborted ? 'killed' : 'failed',
            detail: `download task ${current.id}: ${current.state}`,
            result: JSON.stringify({ downloadTask: envelope(current), downloaded: current.items.filter(item => item.state === 'completed').length, requested: current.items.length,
              ...(current.verifiedButUnrecordedReceipts?.length ? { verifiedButUnrecordedReceipts: current.verifiedButUnrecordedReceipts, registrationError: current.registrationError, registryStateRecorded: current.registryStateRecorded } : {}) }),
          })),
          };
        },
      });
      return run;
    } catch (error) {
      callerSignal?.removeEventListener('abort', abort); activeRuns.delete(key); await this.store.removeLease(task.id, lease);
      await this.update(task.id, task.ownerSessionId, current => { current.state = 'interrupted'; current.error = { code: 'JOB_ADMISSION_FAILED', message: 'No runner was started; resume explicitly after fixing job availability' }; });
      throw error;
    }
  }

  /** @param task Accepted batch. @param agent Actual owner. @param background Explicit native transport mode. @param run Owned controller/receipt accumulator. @param job Progress observer. @returns Completion after ordered selections; verified but unrecorded receipts survive storage failure. */
  async execute(task, agent, background, run, job) {
    const signal = run.controller.signal;
    run.latestTask = await this.update(task.id, task.ownerSessionId, current => { current.state = 'running'; current.jobId = run.jobId; delete current.error; });
    for (const original of task.items) {
      signal.throwIfAborted();
      await this.caller(agent, true);
      const current = await this.readTask(task.id, { ownerSessionId: task.ownerSessionId, cwd: task.cwd }), item = current.items[original.index - 1];
      if (item.state === 'completed') { await this.verify(current, item, item.result, signal); continue; }
      const duplicate = item.videoId === null ? null : current.items.find(other => other.index !== item.index && other.state === 'completed' && other.videoId === item.videoId);
      if (duplicate) {
        const receipt = await this.verify(current, item, duplicate.result, signal);
        run.pendingReceipts = [{ index: item.index, ...receipt }];
        run.latestTask = await this.update(task.id, task.ownerSessionId, current => { Object.assign(current.items[item.index - 1], { state: 'completed', videoId: idOf(receipt.source), result: receipt, reused: true, reusedFromIndex: duplicate.index }); });
        run.pendingReceipts = [];
        continue;
      }
      if (item.videoId !== null) {
        const previous = (await this.store.read()).tasks.filter(other => other.id !== current.id && other.cwd === current.cwd)
          .flatMap(other => other.items).find(other => other.state === 'completed' && other.videoId === item.videoId);
        if (previous) {
          const receipt = await this.verify(current, item, previous.result, signal);
          run.pendingReceipts = [{ index: item.index, ...receipt }];
          run.latestTask = await this.update(task.id, task.ownerSessionId, current => { Object.assign(current.items[item.index - 1], { state: 'completed', videoId: idOf(receipt.source), result: receipt, reused: true }); });
          run.pendingReceipts = [];
          continue;
        }
      }
      job.updateProgress(`${current.items.filter(item => item.state === 'completed').length}/${task.items.length} verified; video ${item.index}`);
      await this.update(task.id, task.ownerSessionId, current => { current.items[item.index - 1].state = 'running'; });
      let result;
      try { result = await this.acquireVideo(agent, item.url, task.selection.publicOnly, signal, { background }); }
      catch (error) { signal.throwIfAborted(); result = blocked({ code: error.code }); }
      if (result?.status === 'downloaded') {
        const receipt = await this.verify(current, item, result, undefined);
        run.pendingReceipts = [{ index: item.index, ...receipt }];
        run.latestTask = await this.update(task.id, task.ownerSessionId, current => { Object.assign(current.items[item.index - 1], { state: 'completed', videoId: idOf(receipt.source), result: receipt }); delete current.items[item.index - 1].error; });
        run.pendingReceipts = [];
      } else {
        signal.throwIfAborted();
        const diagnostic = blocked(result), state = /LOGIN|VERIFICATION|ACCESS_RESTRICTED|USER_ACTION/.test(diagnostic.code) ? 'waiting_user' : 'waiting_source';
        await this.update(task.id, task.ownerSessionId, current => { Object.assign(current.items[item.index - 1], { state, result: diagnostic }); });
      }
    }
    const final = await this.readTask(task.id, { ownerSessionId: task.ownerSessionId, cwd: task.cwd });
    if (!final.items.every(item => item.state === 'completed')) signal.throwIfAborted();
    run.latestTask = await this.update(task.id, task.ownerSessionId, current => {
      current.state = current.items.every(item => item.state === 'completed') ? 'completed' : current.items.some(item => item.state === 'waiting_user') ? 'waiting_user' : 'waiting_source';
    });
  }

  /** @param args Session-owned task action. @param agent Exact live caller. @param signal Control-call cancellation, never attached to an accepted resumed runner. @returns Owned task state; cancel awaits actual cleanup and resume creates a new job. */
  control(args, agent, signal) {
    const operation = this.controlRequest(args, agent, signal);
    this.admitting.add(operation);
    void operation.then(() => this.admitting.delete(operation), () => this.admitting.delete(operation));
    return operation;
  }

  /** @param args Validated control JSON. @param agent Exact caller. @param signal Pre-acceptance control cancellation. @returns Offline state or explicit resumed/canceled outcome. */
  async controlRequest(args, agent, signal) {
    if (!args || typeof args !== 'object' || Object.keys(args).some(key => !['action', 'taskId'].includes(key)) || !['list', 'status', 'resume', 'cancel'].includes(args.action) || (args.action === 'list') !== (args.taskId === undefined)) throw taskError('DOUYIN_TASK_INVALID', 'Task controls accept list or one taskId with status/resume/cancel');
    const owner = await this.caller(agent, args.action === 'resume');
    if (this.closing && args.action === 'resume') throw taskError('DOUYIN_TASK_INVALID', 'Download plugin is unloading');
    signal?.throwIfAborted(); await this.ready();
    if (args.action === 'list') {
      const tasks = (await this.store.read()).tasks.filter(task => task.ownerSessionId === owner.ownerSessionId && task.cwd === owner.cwd);
      return { tasks: tasks.map(task => ({ downloadTask: envelope(task), task: publicTask(task) })), count: tasks.length, complete: true };
    }
    let task = await this.readTask(args.taskId, owner);
    const active = activeRuns.get(`${this.store.directory}:${task.id}`);
    if (args.action === 'cancel') {
      if (active) { active.stopState = 'cancelled'; active.controller.abort(new Error('Download task canceled by its owner')); await active.done; }
      else if (['queued', 'running'].includes(task.state)) throw taskError('DOUYIN_TASK_LOCKED', 'Another Host may still own this runner; cancellation cannot claim it stopped');
      else if (task.state !== 'completed') await this.update(task.id, owner.ownerSessionId, current => { current.state = 'cancelled'; });
      task = await this.readTask(task.id, owner);
    }
    if (args.action === 'resume') {
      if (active) throw taskError('DOUYIN_TASK_LOCKED', 'This download task already has a live runner');
      try { for (const item of task.items) if (item.state === 'completed') await this.verify(task, item, item.result, signal); }
      catch (error) { await this.update(task.id, owner.ownerSessionId, current => { current.state = 'interrupted'; current.error = { code: 'DOUYIN_RECEIPT_INVALID', message: 'A completed file failed revalidation; inspect the file and receipt before retrying' }; }); throw taskError('DOUYIN_RECEIPT_INVALID', 'A completed receipt could not be revalidated; no new download started'); }
      if (task.state !== 'completed') {
        await this.update(task.id, owner.ownerSessionId, current => { current.state = 'queued'; });
        const run = await this.start(task, agent, true);
        return { status: 'queued', downloadTask: { id: task.id, state: 'queued', jobId: run.jobId } };
      }
    }
    return { downloadTask: envelope(task), task: publicTask(task) };
  }

  /** @returns Completion after all admitted subprocess/native operations and final state writes settle. */
  async dispose() {
    this.closing = true;
    for (const run of activeRuns.values()) if (this.running.has(run.done) && !run.controller.signal.aborted) { run.stopState = 'interrupted'; run.controller.abort(new Error('Douyin plugin unloaded')); }
    await Promise.allSettled([...this.admitting]);
    await Promise.allSettled([...this.running]);
  }
}
