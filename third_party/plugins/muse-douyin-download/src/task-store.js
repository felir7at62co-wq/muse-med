/** Private Host-owned download state with cooperative cross-process locking and atomic revision-checked writes. */
import { mkdir, open, readFile, rename, unlink, lstat, realpath, link } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeEvidence, receiptFields } from './receipt.js';
import { tryReclaimLock } from './registry-lock.js';

/** One module instance identifies this Host's private leases; it is never a public job ID. */
export const hostInstance = randomUUID();
/** Shared live runners prevent a newly scoped controller from reclaiming another controller's execution. */
export const activeRuns = new Map();
/** @param value Text or bytes. @returns Its complete lowercase SHA-256 digest. */
export const digest = value => createHash('sha256').update(value).digest('hex');
/** @param code Stable task diagnostic. @param message Credential-free description. @returns A coded error. */
export const taskError = (code, message) => Object.assign(new Error(message), { code });
const encode = value => JSON.stringify(value, null, 2) + '\n';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const absent = error => error.code === 'ENOENT';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** @param value Persisted owner metadata. @param recovery Whether the tagged recovery record is required. @returns Whether every known ownership field is complete. */
function completeOwner(value, recovery = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = recovery ? ['format', 'pid', 'token', 'hostInstance'] : ['pid', 'token', 'hostInstance'];
  return Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 0x7fffffff
    && typeof value.token === 'string' && uuid.test(value.token)
    && typeof value.hostInstance === 'string' && uuid.test(value.hostInstance)
    && (!recovery || value.format === 'muse-douyin-reclaim.v2')
    && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
}

/** @param file Exclusive destination. @param record Complete private owner metadata. @returns Publication after writing the complete record, without an empty ownership window. */
async function publishOwner(file, record) {
  const temporary = `${file}-${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(encode(record)); await handle.sync(); } finally { await handle.close(); }
    await link(temporary, file);
  } finally {
    try { await unlink(temporary); }
    catch (_error) { /* A private temporary alias cannot arbitrate ownership; retaining it must not discard a published lock's release handle. */ }
  }
}

/** One private registry shared by scoped plugin instances; no source media URLs or credentials belong here. */
export class TaskStore {
  /** @param settings Resolved plugin settings. */
  constructor(settings) { this.settings = settings; this.directory = null; this.initialization = null; }

  /** @returns Completion after private paths exist and dead-runner records are classified without replaying work. */
  ready() {
    this.initialization ??= this.initialize();
    return this.initialization;
  }

  /** @returns Private initialization with no media/network replay; ambiguous live leases remain untouched. */
  async initialize() {
    if (!this.settings.settingsHome) throw taskError('DOUYIN_TASK_STATE_HOME_REQUIRED', 'Persistent downloads require the Host settingsHome directory');
    const home = await realpath(this.settings.settingsHome);
    this.directory = join(home, 'plugin-data', 'muse-douyin-download', 'tasks', 'v1');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.directory) !== this.directory) throw taskError('DOUYIN_TASK_INVALID', 'Task state directory must be a private real directory');
    this.file = join(this.directory, 'registry.json');
    await this.transaction(async registry => {
      for (const task of registry.tasks) {
        const key = `${this.directory}:${task.id}`;
        if (task.jobId !== null && task.jobRegistryInstance !== this.jobRegistryInstance && !activeRuns.has(key)) { task.jobId = null; task.revision++; }
        if (!['queued', 'running'].includes(task.state)) continue;
        const lease = await this.lease(task.id);
        if (activeRuns.has(key)) continue;
        if (lease && alive(lease.pid)) continue;
        task.state = 'interrupted'; task.jobId = null; task.updatedAt = new Date().toISOString(); task.revision++;
        for (const item of task.items) if (item.state === 'running') item.state = 'interrupted';
        if (lease) await this.removeLease(task.id, lease.token);
      }
    });
  }

  /** @param file Private state or already-contained receipt path. @param maxBytes Inclusive complete-read cap. @returns Complete bytes; concurrent file growth cannot exceed the read budget. */
  async readBounded(file, maxBytes = this.settings.taskRegistryMaxBytes) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw taskError('DOUYIN_TASK_LIMIT', 'Task state file is not a bounded regular file');
    const handle = await open(file, 'r');
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of handle.createReadStream({ start: 0, end: maxBytes, autoClose: false })) {
        size += chunk.length;
        if (size > maxBytes) throw taskError('DOUYIN_TASK_LIMIT', 'Task state exceeds its byte budget');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    } finally { await handle.close(); }
  }

  /** @returns Validated v1 registry; unsupported states and receiptless completion fail without mutations. */
  async read() {
    let bytes;
    try { bytes = await this.readBounded(this.file); }
    catch (error) { if (!absent(error)) throw error; return { schemaVersion: 1, revision: 0, tasks: [] }; }
    let record;
    try { record = JSON.parse(bytes.toString('utf8')); }
    catch (error) { throw taskError('DOUYIN_TASK_INVALID', 'Download registry JSON is invalid'); }
    if (!record || typeof record !== 'object' || record.schemaVersion !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 0 || !Array.isArray(record.tasks) || record.tasks.length > this.settings.taskMaxTasks || new Set(record.tasks.map(task => task?.id)).size !== record.tasks.length) throw taskError('DOUYIN_TASK_INVALID', 'Unsupported or oversized download registry');
    if (record.tasks.some(task => !task || typeof task !== 'object' || task.schemaVersion !== 1 || !/^dyt-[a-f0-9]{32}$/.test(task.id) || typeof task.ownerSessionId !== 'string' || !Number.isSafeInteger(task.revision) || task.revision < 0 || !Array.isArray(task.items) || task.items.length > this.settings.maxVideos)) throw taskError('DOUYIN_TASK_INVALID', 'Invalid persisted task identity or item count');
    const states = ['queued', 'running', 'completed', 'waiting_user', 'waiting_source', 'interrupted', 'cancelled', 'failed'];
    for (const task of record.tasks) {
      if (Object.keys(task).some(key => !['id', 'schemaVersion', 'revision', 'ownerSessionId', 'acceptanceKey', 'cwd', 'selection', 'state', 'jobId', 'createdAt', 'updatedAt', 'items', 'error', 'jobRegistryInstance'].includes(key))) throw taskError('DOUYIN_TASK_INVALID', 'Task record contains unsupported private fields');
      if (!states.includes(task.state) || !isAbsolute(task.cwd ?? '') || !/^[a-f0-9]{64}$/.test(task.acceptanceKey ?? '') || task.id !== `dyt-${task.acceptanceKey.slice(0, 32)}` || !task.selection || !Array.isArray(task.selection.urls) || typeof task.selection.single !== 'boolean' || typeof task.selection.publicOnly !== 'boolean' || task.selection.urls.length !== task.items.length || !task.items.length) throw taskError('DOUYIN_TASK_INVALID', 'Invalid task owner, selection or durable state');
      for (const [index, item] of task.items.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw taskError('DOUYIN_TASK_INVALID', 'Task items must be records');
        if (Object.keys(item).some(key => !['index', 'url', 'videoId', 'state', 'result', 'error', 'reused', 'reusedFromIndex'].includes(key))) throw taskError('DOUYIN_TASK_INVALID', 'Task item contains unsupported fields');
        if (item.index !== index + 1 || item.url !== task.selection.urls[index] || !/^https:\/\/(?:www\.douyin\.com\/video\/\d{10,25}|v\.douyin\.com\/[A-Za-z0-9_-]+\/?)$/.test(item.url ?? '') || item.videoId !== null && !/^\d{10,25}$/.test(item.videoId) || !['pending', 'running', 'completed', 'waiting_user', 'waiting_source', 'interrupted'].includes(item.state)) throw taskError('DOUYIN_TASK_INVALID', 'Task source identity or item state is invalid');
        const selectedId = /^https:\/\/www\.douyin\.com\/video\/(\d{10,25})$/.exec(item.url)?.[1];
        if (selectedId && item.videoId !== selectedId) throw taskError('DOUYIN_TASK_INVALID', 'Task video identity changed from its original selection');
        if (item.state === 'completed') {
          const result = item.result;
          if (result && Object.keys(result).some(key => !receiptFields.includes(key))) throw taskError('DOUYIN_TASK_INVALID', 'Verified result contains unsupported fields');
          if (!result || result.status !== 'downloaded' || result.full_decode_verified !== true || result.source !== `https://www.douyin.com/video/${item.videoId}` || !isAbsolute(result.path ?? '') || result.receipt !== result.path + '.source.json' || !Number.isSafeInteger(result.bytes) || result.bytes <= 0 || !/^[a-f0-9]{64}$/.test(result.sha256 ?? '') || typeof result.duration_seconds !== 'number' || !Number.isFinite(result.duration_seconds) || result.duration_seconds <= 0) throw taskError('DOUYIN_TASK_INVALID', 'A completed task item requires its verified source receipt');
          if (result.evidence !== undefined) nativeEvidence(result.evidence, item.videoId, this.settings.taskReceiptMaxBytes);
        }
      }
      if (task.state === 'completed' && !task.items.every(item => item.state === 'completed')) throw taskError('DOUYIN_TASK_INVALID', 'A completed task requires every selected item to have completed');
    }
    return record;
  }

  /** @param signal Cancels lock admission. @returns Exclusive release function; dead-owner reclamation never unlinks a newer live lock. */
  async lock(signal) {
    const file = join(this.directory, '.registry.lock'), token = randomUUID(), until = Date.now() + this.settings.taskLockTimeoutMs;
    while (true) {
      signal?.throwIfAborted();
      try {
        await publishOwner(file, { pid: process.pid, hostInstance, token });
        return async () => {
          const current = JSON.parse((await this.readBounded(file, 4096)).toString('utf8'));
          if (!completeOwner(current) || current.pid !== process.pid || current.hostInstance !== hostInstance
            || current.token !== token) throw taskError('DOUYIN_TASK_STALE', 'Task registry lock ownership changed');
          await unlink(file);
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let current;
        try { current = JSON.parse((await this.readBounded(file, 4096)).toString('utf8')); }
        catch (readError) { if (absent(readError)) continue; }
        if (completeOwner(current) && !alive(current.pid)) {
          const reclaim = join(this.directory, '.registry.reclaim');
          const releaseKernel = await tryReclaimLock(this.directory);
          if (releaseKernel) {
            let ownedGuard = false;
            try {
              let previous;
              try { previous = JSON.parse((await this.readBounded(reclaim, 4096)).toString('utf8')); }
              catch (readError) { if (!absent(readError) && !(readError instanceof SyntaxError)) throw readError; }
              if (completeOwner(previous, true) && !alive(previous.pid)) await unlink(reclaim);
              try {
                await publishOwner(reclaim, { format: 'muse-douyin-reclaim.v2', pid: process.pid, hostInstance, token });
                ownedGuard = true;
              } catch (claimError) { if (claimError.code !== 'EEXIST') throw claimError; }
              if (ownedGuard) {
                let latest;
                try { latest = JSON.parse((await this.readBounded(file, 4096)).toString('utf8')); }
                catch (readError) { if (!absent(readError)) throw readError; }
                if (completeOwner(latest) && latest.pid === current.pid && latest.hostInstance === current.hostInstance
                  && latest.token === current.token && !alive(latest.pid)) await unlink(file);
              }
            } finally {
              try {
                if (ownedGuard) {
                  const guard = JSON.parse((await this.readBounded(reclaim, 4096)).toString('utf8'));
                  if (!completeOwner(guard, true) || guard.pid !== process.pid || guard.hostInstance !== hostInstance
                    || guard.token !== token) throw taskError('DOUYIN_TASK_STALE', 'Registry reclaim ownership changed');
                  await unlink(reclaim);
                }
              } finally { await releaseKernel(); }
            }
            if (ownedGuard) continue;
          }
        }
        if (Date.now() >= until) throw taskError('DOUYIN_TASK_LOCKED', 'Another Host may own the download registry; no live lock was reclaimed');
        await delay(this.settings.taskLockPollMs, undefined, { signal });
      }
    }
  }

  /** @param change Mutation while holding the private lock. @param signal Cancels lock admission. @returns The mutation result after atomic publication; committed writes are not raced against cancellation. */
  async transaction(change, signal) {
    const release = await this.lock(signal);
    let temporary;
    try {
      const registry = await this.read(), before = encode(registry), expected = registry.revision;
      const result = await change(registry);
      if (encode(registry) === before) return result;
      if (registry.tasks.length > this.settings.taskMaxTasks) throw taskError('DOUYIN_TASK_LIMIT', 'Download registry reached taskMaxTasks');
      registry.revision = expected + 1;
      const text = encode(registry);
      if (Buffer.byteLength(text) > this.settings.taskRegistryMaxBytes) throw taskError('DOUYIN_TASK_LIMIT', 'Download registry exceeds taskRegistryMaxBytes');
      if (encode(await this.read()) !== before) throw taskError('DOUYIN_TASK_STALE', 'Task registry changed outside its private lock');
      temporary = join(this.directory, `.registry-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.file); temporary = undefined;
      return structuredClone(result);
    } finally {
      if (temporary) await unlink(temporary).catch(error => { if (!absent(error)) throw error; });
      await release();
    }
  }

  /** @param id Durable task ID. @returns Existing private execution lease or null. */
  async lease(id) {
    try { return JSON.parse((await this.readBounded(join(this.directory, `${id}.lease`), 4096)).toString('utf8')); }
    catch (error) { if (absent(error)) return null; throw error; }
  }

  /** @param id Durable task ID. @returns Exclusive execution lease token; never steals an alive or ambiguous Host lease. */
  async acquireLease(id) {
    return this.transaction(async () => {
      const file = join(this.directory, `${id}.lease`), token = randomUUID();
      const previous = await this.lease(id);
      if (previous) {
        if (alive(previous.pid)) throw taskError('DOUYIN_TASK_LOCKED', 'A live or unknown Host still owns this download task');
        await this.removeLease(id, previous.token);
      }
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(encode({ pid: process.pid, hostInstance, token })); } finally { await handle.close(); }
      return token;
    });
  }

  /** @param id Durable task ID. @param token Exact lease owner. @returns Completion after removing only the owned lease. */
  async removeLease(id, token) {
    const lease = await this.lease(id);
    if (lease?.token !== token) throw taskError('DOUYIN_TASK_STALE', 'Download execution lease ownership changed');
    await unlink(join(this.directory, `${id}.lease`));
  }
}
