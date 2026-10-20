/** Durable verified episodes, source-free catalog checkpoints, and discovery of previous Muse receipts. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { DownloadError } from './errors.js';
import { validateMp4 } from './media.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (root, path) => { const part = relative(root, path); return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };
const completeList = item => Number.isSafeInteger(item.episodeCount) && item.episodeCount > 0
  && Array.isArray(item.episodes) && item.episodes.length === item.episodeCount
  && item.episodes.every((episode, index) => record(episode) && episode.index === index + 1);

async function privateJson(path, maximum) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) return null;
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Refuse linked ancestors before trusting a retained file's bytes or writing a checkpoint child. */
async function regularPath(root, path, directory = false) {
  if (!within(root, path)) return false;
  let current = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, component);
    let info;
    try { info = await lstat(current); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (info.isSymbolicLink() || (current === path && !directory ? !info.isFile() : !info.isDirectory())) return false;
  }
  return await realpath(path) === path;
}

/**
 * Check retained bytes against their original full-decode receipt.
 * @param root - Canonical output directory that must contain every retained file.
 * @param episode - Persisted episode metadata to validate.
 * @param config - Resolved file-size limits.
 * @param signal - Cancellation for hashing and file inspection.
 * @returns Whether the unchanged MP4 still matches its receipt.
 */
export async function verifiedEpisode(root, episode, config, signal) {
  if (!record(episode) || !Number.isSafeInteger(episode.index) || episode.index < 1
    || typeof episode.path !== 'string' || !isAbsolute(episode.path)
    || !Number.isSafeInteger(episode.bytes) || episode.bytes <= 0 || episode.bytes > config.maxEpisodeBytes
    || !/^[a-f0-9]{64}$/.test(episode.sha256) || episode.fullDecodeChecked !== true
    || episode.validationLevel !== 'ffprobe-full-decode-sha256'
    || !await regularPath(root, episode.path)) return false;
  signal.throwIfAborted();
  if ((await lstat(episode.path)).size !== episode.bytes) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(episode.path, { signal })) hash.update(chunk);
  if (hash.digest('hex') !== episode.sha256) return false;
  try { await validateMp4(episode.path); } catch (error) { if (error instanceof DownloadError) return false; throw error; }
  return true;
}

/**
 * Find complete historical receipts within the selected output tree.
 * @param root - Canonical output directory.
 * @param mode - Source mode required in each receipt.
 * @param config - Resolved search-depth, entry and response-size limits.
 * @param signal - Cancellation for directory traversal.
 * @param sourceIdentity - Manifest digest required for manifest-mode reuse.
 * @returns Complete series metadata and whether the search limit was reached.
 */
export async function discoverReceipts(root, mode, config, signal, sourceIdentity = null) {
  const items = [], queue = [[root, 0]];
  let scanned = 0, truncated = false;
  while (queue.length) {
    signal.throwIfAborted();
    const [directory, depth] = queue.shift();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (++scanned > config.resumeSearchEntries) { truncated = true; break; }
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth < config.resumeSearchDepth && !entry.name.startsWith('.')) queue.push([path, depth + 1]);
      if (!entry.isFile() || entry.name !== 'download-manifest.json') continue;
      const value = await privateJson(path, config.maxResponseBytes);
      if (!record(value) || value.ok !== true || value.sourceMode !== mode || mode === 'manifest' && value.sourceIdentity !== sourceIdentity || !Array.isArray(value.items)) continue;
      for (const item of value.items) {
        if (record(item) && typeof item.seriesId === 'string' && typeof item.title === 'string'
          && typeof item.source === 'string' && typeof item.path === 'string' && item.complete === true && completeList(item)) items.push(item);
      }
    }
    if (truncated) break;
  }
  return { items, truncated };
}

/**
 * Validate a historical series before reusing any requested episode.
 * @param root - Canonical directory containing retained files.
 * @param items - Historical complete series receipts.
 * @param id - Exact series ID to reuse.
 * @param selected - Requested episode numbers, or null for the declared full list.
 * @param config - Resolved file limits.
 * @param signal - Cancellation for retained-file validation.
 * @returns Verified metadata, or null when a requested file needs downloading.
 */
export async function reusableSeries(root, items, id, selected, config, signal) {
  for (const item of items.filter(item => item.seriesId === id)) {
    const episodes = selected ? item.episodes.filter(episode => selected.includes(episode.index)) : item.episodes;
    if (selected && episodes.length !== selected.length) continue;
    let valid = true;
    for (const episode of episodes) if (!await verifiedEpisode(root, episode, config, signal)) { valid = false; break; }
    if (valid) return { ...item, episodes, downloadedEpisodeCount: episodes.length, complete: episodes.length === item.episodeCount };
  }
  return null;
}

/** One stable request directory survives cancellation, process exit and retry without storing media URLs or encryption keys. */
export class DownloadCheckpoint {
  constructor(root, options, config) {
    this.root = root; this.config = config;
    this.request = { mode: options.mode, seriesIds: options.seriesIds, episodes: options.episodes, sourceIdentity: options.sourceIdentity ?? null };
    const id = createHash('sha256').update(JSON.stringify(this.request)).digest('hex').slice(0, 32);
    this.directory = join(root, `hongguo-${id}`);
    this.file = join(this.directory, 'resume-state.json');
  }

  /** Load only a matching, versioned checkpoint with complete catalogs and bounded metadata. */
  async read() {
    if (!await regularPath(this.root, this.directory, true)) return null;
    const value = await privateJson(this.file, this.config.maxResponseBytes);
    if (!record(value) || value.version !== 1 || JSON.stringify(value.request) !== JSON.stringify(this.request)
      || !Array.isArray(value.plans) || !Array.isArray(value.completed)
      || value.completed.some(item => !record(item) || typeof item.seriesId !== 'string' || typeof item.vid !== 'string' || !record(item.episode))
      || value.plans.length !== this.request.seriesIds.length
      || value.plans.some((plan, index) => !record(plan) || plan.seriesId !== this.request.seriesIds[index] || typeof plan.title !== 'string'
        || typeof plan.source !== 'string' || !completeList(plan)
        || new Set(plan.episodes.map(episode => episode.vid)).size !== plan.episodes.length
        || plan.episodes.some(episode => typeof episode.vid !== 'string' || !episode.vid))) return null;
    return value;
  }

  /** Serialize the complete request across processes; dead process locks are recovered by the shared file writer. */
  async locked(operation) {
    try { if ((await lstat(this.directory)).isSymbolicLink()) throw new DownloadError('unsafe_path', '续下载目录包含链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!await regularPath(this.root, this.directory, true)) throw new DownloadError('unsafe_path', '续下载目录包含链接或已被替换');
    try { return await withFileLock(this.file, operation, { waitMs: 0 }); }
    catch (error) {
      if (error.message?.startsWith('atomic-write: timed out')) throw new DownloadError('download_in_progress', '同一下载任务正在运行；请等待原任务，不要并行重复提交');
      throw error;
    }
  }

  /** Commit only completed validation results; a crash can lose a receipt update but cannot publish a partial video as verified. */
  async save(state) {
    const text = JSON.stringify(state, null, 2) + '\n';
    if (Buffer.byteLength(text) > this.config.maxResponseBytes) throw new DownloadError('checkpoint_size', '下载进度超过配置的 maxResponseBytes，已完成文件已保留');
    if (!await regularPath(this.root, this.directory, true)) throw new DownloadError('unsafe_path', '续下载目录已被替换');
    await writeFileAtomic(this.file, text, { mode: 0o600 });
  }

  /** Atomically publish the complete request receipt without discarding its recovery journal. */
  async publish(value) {
    await writeFileAtomic(join(this.directory, 'download-manifest.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  }

  /** Remove only incomplete owned transfer files; verified episodes and their journal remain resumable. */
  async clearParts() {
    if (!await regularPath(this.root, this.directory, true)) return;
    for (const folder of await readdir(this.directory, { withFileTypes: true })) {
      if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
      const path = join(this.directory, folder.name);
      for (const file of await readdir(path, { withFileTypes: true })) {
        if (file.name.endsWith('.part') && file.isFile()) await rm(join(path, file.name));
      }
    }
  }

  /** Require real child directories before saving a new episode. */
  async folder(name) {
    const path = join(this.directory, name);
    try { if ((await lstat(path)).isSymbolicLink()) throw new DownloadError('unsafe_path', '视频保存目录包含链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (!await regularPath(this.root, path, true)) throw new DownloadError('unsafe_path', '视频保存目录包含链接或已被替换');
    return path;
  }
}
