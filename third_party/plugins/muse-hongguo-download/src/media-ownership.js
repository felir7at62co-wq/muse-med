/** Durable process leases prevent reuse and cleanup before native exit has been confirmed. */
import { mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DownloadError } from './errors.js';
const prefix = '.media-process-';

/**
 * Find unfinished process leases before reuse or cleanup.
 * @param {string} workspace Directory containing process leases.
 * @param {Set<string>} owned Optional directories registered by this live processor; omitted inspects every lease.
 * @returns {Promise<string|null>} First unowned lease path, or null.
 */
export async function pendingMediaProcess(workspace, owned) {
  let names;
  try { names = await readdir(workspace); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return names.filter(name => name.startsWith(prefix)).map(name => join(workspace, name)).find(path => !owned?.has(path)) ?? null;
}

/**
 * Report unconfirmed process exit without private native diagnostics.
 * @param {string} path Retained private stage to inspect before recovery.
 * @returns {DownloadError} Safe failure carrying the retained path.
 */
export function mediaCleanupError(path) {
  return new DownloadError('cleanup_unconfirmed', '无法确认视频进程已退出；暂存文件已保留，请先检查进程后再恢复任务', { cleanupPendingPath: path });
}

/**
 * Register private ownership before making a durable process lease visible.
 * @param {string} workspace Canonical directory containing operation stages.
 * @param {string[]} paths Owned input and output paths; no source credentials.
 * @param {Set<string>} owned Live processor registry updated before directory creation.
 * @returns {Promise<string>} Private lease directory created before native work starts.
 */
export async function createMediaLease(workspace, paths, owned) {
  const directory = join(workspace, prefix + randomUUID());
  owned.add(directory);
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
    await writeFile(join(directory, 'lease.json'), JSON.stringify({ version: 1, state: 'process-exit-unconfirmed', paths }) + '\n', { flag: 'wx', mode: 0o600 });
    return directory;
  } catch (error) { if (created) await rm(directory, { recursive: true, force: true }); owned.delete(directory); throw error; }
}
