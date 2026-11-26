/** Workspace-private task records and generation-fenced control requests; media checkpoints have a separate writer. */
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { DownloadError } from './errors.js';

export const taskStates = ['queued', 'running', 'paused', 'cancelled', 'completed', 'failed', 'interrupted', 'blocked'];
export const taskError = (code, message) => new DownloadError(code, message);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const validTaskId = id => typeof id === 'string' && /^hgt-[a-f0-9]{32}$/.test(id);
export const validRunId = id => typeof id === 'string' && /^hgr-[a-f0-9]{32}$/.test(id);
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const sourceStages = ['catalog', 'video_model', 'source_api'];
const sourceNames = ['web', 'app', 'api'];
const sourceFailureCodes = new Set([
  'APP_INPUT', 'BUSINESS_REJECTED', 'DEVICE_REGISTRATION_FAILED', 'EMPTY_RESPONSE', 'ERR_WEB_MEDIA_ADDRESS',
  'ETIMEDOUT', 'INVALID_RESPONSE', 'MISSING_MODEL', 'NETWORK_ERROR', 'NO_PLAYABLE_SOURCE',
  'PREVIEW_ONLY', 'SECURITY_BLOCKED', 'TIMEOUT',
]);
const maxSourceFailures = 6;
const sourceFailure = value => object(value) && sourceNames.includes(value.source) && typeof value.code === 'string'
  && (sourceFailureCodes.has(value.code) || /^HTTP_[345]\d{2}$/.test(value.code));

/** Persist known diagnostic fields only. Upstream messages and unknown codes do not enter the task record. */
export function taskSourceDiagnostic(value) {
  const failures = Array.isArray(value.sourceFailures)
    ? value.sourceFailures.slice(0, maxSourceFailures).filter(sourceFailure).map(({ source, code }) => ({ source, code }))
    : [];
  const sourceStage = sourceStages.includes(value.sourceStage) ? value.sourceStage : undefined;
  if (sourceStage === undefined && !failures.length) return {};
  return { sourceDiagnostic: {
    ...(sourceStage === undefined ? {} : { sourceStage }),
    ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
    ...(failures.length ? { sourceFailures: failures } : {}),
  } };
}

function validSourceDiagnostic(value) {
  return object(value) && keys(value, ['sourceStage', 'retryable', 'sourceFailures'])
    && (value.sourceStage !== undefined || value.sourceFailures !== undefined)
    && (value.sourceStage === undefined || sourceStages.includes(value.sourceStage))
    && (value.retryable === undefined || typeof value.retryable === 'boolean')
    && (value.sourceFailures === undefined || Array.isArray(value.sourceFailures)
      && value.sourceFailures.length > 0 && value.sourceFailures.length <= maxSourceFailures
      && value.sourceFailures.every(item => sourceFailure(item) && keys(item, ['source', 'code'])));
}

const owner = value => object(value) && keys(value, ['kind', 'id']) && ['session', 'cli'].includes(value.kind) && typeof value.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.id);

/** Only ESRCH proves that a local runner process has exited; PID reuse and permission errors remain locked. */
export function processGone(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

/** One canonical workspace owns these records; all mutation uses short per-task file transactions. */
export class TaskStore {
  constructor(cwd, config) { this.cwd = cwd; this.config = config; this.directory = join(cwd, config.taskDirectory); }
  async ready(create = false) {
    if (await realpath(this.cwd) !== this.cwd || !(await lstat(this.cwd)).isDirectory()) throw taskError('task_workspace_changed', '下载任务工作区已变化');
    let path = this.cwd;
    for (const part of this.config.taskDirectory.split('/')) {
      path = join(path, part);
      if (create) { try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
      let entry;
      try { entry = await lstat(path); } catch (error) { if (!create && error.code === 'ENOENT') return false; throw error; }
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw taskError('task_unsafe_path', '下载任务目录包含链接或不是文件夹');
    }
    return true;
  }
  path(id) { if (!validTaskId(id)) throw taskError('task_invalid', '下载任务 ID 无效'); return join(this.directory, `${id}.json`); }
  runPath(id) { this.path(id); return join(this.directory, `${id}.run`); }
  async json(path) {
    let entry;
    try { entry = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > this.config.taskMaxStateBytes) throw taskError('task_state_invalid', '下载任务记录无效，已保留供检查');
    try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
      if (error instanceof SyntaxError) throw taskError('task_state_invalid', '下载任务记录无效，已保留供检查');
      throw error;
    }
  }
  validate(value, id) {
    if (!object(value) || !keys(value, ['version', 'kind', 'id', 'owner', 'cwd', 'request', 'sourceIdentity', 'checkpointDirectory', 'state', 'revision', 'runId', 'runnerPid', 'jobId', 'progress', 'summary', 'createdAt', 'updatedAt']) || value.version !== 1 || value.kind !== 'download' || value.id !== id || !owner(value.owner) || value.cwd !== this.cwd
      || !Number.isSafeInteger(value.revision) || value.revision < 0 || !taskStates.includes(value.state)
      || !object(value.request) || !keys(value.request, ['seriesIds', 'sourceMode', 'quality', 'outputDir', 'episodes']) || !Array.isArray(value.request.seriesIds) || !value.request.seriesIds.length
      || value.request.seriesIds.some(item => typeof item !== 'string' || !item || item.length > 120)
      || !['1080p', '720p', 'auto'].includes(value.request.quality)
      || !['legacy', 'manifest', 'public'].includes(value.request.sourceMode)
      || typeof value.request.outputDir !== 'string' || !isAbsolute(value.request.outputDir)
      || typeof value.checkpointDirectory !== 'string' || !isAbsolute(value.checkpointDirectory)
      || value.runId !== null && !validRunId(value.runId)
      || value.runnerPid !== null && (!Number.isSafeInteger(value.runnerPid) || value.runnerPid < 1)
      || value.jobId !== null && (typeof value.jobId !== 'string' || !/^[a-z][a-z0-9-]{1,159}$/.test(value.jobId))
      || value.sourceIdentity !== null && (typeof value.sourceIdentity !== 'string' || value.sourceIdentity.length > 1024)
      || ![value.createdAt, value.updatedAt].every(time => typeof time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time) && Number.isFinite(Date.parse(time)))) {
      throw taskError('task_state_invalid', '下载任务记录无效，已保留供检查');
    }
    if (value.request.episodes !== undefined && (!Array.isArray(value.request.episodes) || !value.request.episodes.length
      || value.request.episodes.some(item => !Number.isSafeInteger(item) || item < 1)
      || new Set(value.request.episodes).size !== value.request.episodes.length)
      || value.progress !== null && (!object(value.progress) || !keys(value.progress, ['recordedCompletedEpisodeCount', 'remainingEpisodeCount', 'requestedQuality'])
        || !Number.isSafeInteger(value.progress.recordedCompletedEpisodeCount) || value.progress.recordedCompletedEpisodeCount < 0
        || !Number.isSafeInteger(value.progress.remainingEpisodeCount) || value.progress.remainingEpisodeCount < 0
        || !['1080p', '720p', 'auto'].includes(value.progress.requestedQuality))
      || value.summary !== null && (!object(value.summary) || !keys(value.summary, ['ok', 'complete', 'code', 'path', 'cleanupPendingPath', 'sourceDiagnostic'])
        || typeof value.summary.ok !== 'boolean' || value.summary.complete !== undefined && typeof value.summary.complete !== 'boolean'
        || value.summary.code !== undefined && (typeof value.summary.code !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.summary.code))
        || value.summary.sourceDiagnostic !== undefined && !validSourceDiagnostic(value.summary.sourceDiagnostic)
        || ['path', 'cleanupPendingPath'].some(key => value.summary[key] !== undefined && (typeof value.summary[key] !== 'string' || !isAbsolute(value.summary[key]))))) {
      throw taskError('task_state_invalid', '下载任务公开字段无效，已保留供检查');
    }
    return value;
  }
  async read(id) {
    if (!await this.ready()) return null;
    const value = await this.json(this.path(id));
    return value === null ? null : this.validate(value, id);
  }
  async list() {
    if (!await this.ready()) return [];
    const names = (await readdir(this.directory)).filter(name => /^hgt-[a-f0-9]{32}\.json$/.test(name));
    if (names.length > this.config.taskMaxRecords) throw taskError('task_limit', '下载任务记录过多，请先整理记录');
    return (await Promise.all(names.map(name => this.read(name.slice(0, -5))))).filter(Boolean);
  }
  async accept(id, create) {
    await this.ready(true);
    return withFileLock(join(this.directory, 'admission'), async () => {
      const existing = await this.read(id);
      if (existing) return { task: existing, created: false };
      if ((await this.list()).length >= this.config.taskMaxRecords) throw taskError('task_limit', '下载任务数量达到上限，请先移除已结束的记录');
      return { task: await this.change(id, () => create()), created: true };
    }, { waitMs: this.config.taskLockWaitMs });
  }
  async change(id, mutate) {
    await this.ready(true);
    return withFileLock(this.path(id), async () => {
      const old = await this.read(id), current = mutate(old === null ? null : structuredClone(old));
      if (current === null) return old;
      current.revision = (old?.revision ?? -1) + 1; current.updatedAt = new Date().toISOString();
      this.validate(current, id);
      const text = JSON.stringify(current) + '\n';
      if (Buffer.byteLength(text) > this.config.taskMaxStateBytes) throw taskError('task_state_limit', '下载任务记录超过配置上限');
      await writeFileAtomic(this.path(id), text, { mode: 0o600 });
      return current;
    }, { waitMs: this.config.taskLockWaitMs });
  }
  async remove(id) {
    await this.ready();
    return withFileLock(this.path(id), async () => {
      const task = await this.read(id);
      if (task === null) return;
      if (['running', 'queued', 'blocked'].includes(task.state)) throw taskError('task_locked', '运行中或清理未确认的任务不能移除');
      await rm(this.path(id));
      await rm(join(this.directory, `${id}.control.json`), { force: true });
    }, { waitMs: this.config.taskLockWaitMs });
  }
  async runner(task) {
    const path = `${this.runPath(task.id)}.lock`;
    let entry;
    try { entry = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return { kind: 'absent' }; throw error; }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 64) return { kind: 'unknown' };
    const text = await readFile(path, 'utf8');
    if (!/^[1-9]\d*\n?$/.test(text)) return { kind: 'unknown' };
    const pid = Number(text.trim());
    if (pid !== task.runnerPid) return { kind: 'unknown' };
    return { kind: processGone(pid) ? 'gone' : 'live' };
  }
  async control(id) {
    if (!await this.ready()) return null;
    const value = await this.json(join(this.directory, `${id}.control.json`));
    if (value === null) return null;
    if (!object(value) || value.version !== 1 || value.taskId !== id || !validRunId(value.runId)
      || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value.requestId)
      || !['pause', 'cancel'].includes(value.action) || !['pending', 'acknowledged', 'rejected'].includes(value.state)) {
      throw taskError('task_control_invalid', '下载控制请求无效，已保留供检查');
    }
    return value;
  }
  async submitControl(task, request) {
    const path = join(this.directory, `${task.id}.control.json`);
    return withFileLock(path, async () => {
      const current = await this.read(task.id);
      if (current?.runId !== request.runId || !['running', 'queued'].includes(current.state)) throw taskError('task_stale_run', '任务运行代次已变化，请重新查看状态');
      const old = await this.control(task.id);
      if (old?.state === 'pending' && old.runId === request.runId) {
        if (old.requestId === request.requestId && old.runId === request.runId && old.action === request.action) return old;
        throw taskError('task_control_pending', '已有停止请求等待确认，请先查看状态');
      }
      const value = { version: 1, taskId: task.id, ...request, state: 'pending' };
      await writeFileAtomic(path, JSON.stringify(value) + '\n', { mode: 0o600 }); return value;
    }, { waitMs: this.config.taskLockWaitMs });
  }
  async acknowledge(id, runId, state) {
    const path = join(this.directory, `${id}.control.json`);
    return withFileLock(path, async () => {
      const request = await this.control(id);
      if (request?.runId !== runId || request.state !== 'pending') return;
      await writeFileAtomic(path, JSON.stringify({ ...request, state }) + '\n', { mode: 0o600 });
    }, { waitMs: this.config.taskLockWaitMs });
  }
}
