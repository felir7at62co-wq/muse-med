/** Verified episode assembly retains original files and waits for every owned native process. */
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, link, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveConfig } from './config.js';
import { DownloadError, safeError } from './errors.js';
import { verifiedEpisode } from './checkpoint.js';
import { validateMp4 } from './media.js';
import { createMediaProcessor } from './runtime.js';
import { createMediaLease, mediaCleanupError } from './media-ownership.js';
import { validTaskId } from './task-store.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw new DownloadError(code, message); };
const outputBytes = 64 * 1024;
const videoFields = ['codec_name', 'codec_tag_string', 'profile', 'level', 'width', 'height', 'pix_fmt', 'sample_aspect_ratio',
  'r_frame_rate', 'time_base', 'extradata_hash', 'color_range', 'color_space', 'color_transfer', 'color_primaries', 'field_order'];
const audioFields = ['codec_name', 'profile', 'sample_rate', 'channels', 'channel_layout', 'time_base', 'extradata_hash'];
const signature = (stream, fields) => stream ? fields.map(key => stream[key] ?? null) : null;

function argumentsFor(args, config) {
  if (!object(args) || Object.keys(args).some(key => !['taskId', 'seriesId', 'episodes', 'mode', 'outputFile'].includes(key))
    || !validTaskId(args.taskId) || args.seriesId !== undefined && (typeof args.seriesId !== 'string' || !args.seriesId || args.seriesId.length > 120)
    || args.mode !== undefined && !['auto', 'copy', 'compatible'].includes(args.mode)) fail('invalid_arguments', '合并参数或任务 ID 无效');
  if (args.episodes !== undefined && (!Array.isArray(args.episodes) || !args.episodes.length || args.episodes.length > config.maxMergeEpisodes
    || args.episodes.some(index => !Number.isSafeInteger(index) || index < 1) || new Set(args.episodes).size !== args.episodes.length)) {
    fail('invalid_arguments', '合并集号必须是不重复的正整数，且不超过 maxMergeEpisodes');
  }
  if (args.outputFile !== undefined && (typeof args.outputFile !== 'string' || !/^[^./\\\x00-\x1f\x7f<>:"|?*][^/\\\x00-\x1f\x7f<>:"|?*]*\.mp4$/i.test(args.outputFile)
    || args.outputFile.trim() !== args.outputFile || Buffer.byteLength(args.outputFile) > 180
    || /^(?:CON|PRN|AUX|NUL|COM\d|LPT\d)\./i.test(args.outputFile))) fail('invalid_arguments', 'outputFile 必须是无路径的有效 .mp4 文件名');
  return { ...args, mode: args.mode ?? 'auto', ...(args.episodes ? { episodes: [...args.episodes].sort((a, b) => a - b) } : {}) };
}

async function hashFile(path, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail('output_exists', '合并目标或回执已存在；已有文件未改动');
}
async function removeOwned(path, identity) {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== identity.dev || entry.ino !== identity.ino) {
    fail('unsafe_path', '合并暂存目录已变化，未清理不属于本次操作的文件');
  }
  await rm(path, { recursive: true });
}
function mergeInfo(text) {
  let value;
  try { value = JSON.parse(text); } catch (error) { fail('invalid_media', '合并输入没有有效的视频探测结果'); }
  const streams = object(value) && Array.isArray(value.streams) ? value.streams : [];
  const videos = streams.filter(stream => object(stream) && stream.codec_type === 'video');
  const audios = streams.filter(stream => object(stream) && stream.codec_type === 'audio');
  const duration = Number(value?.format?.duration), video = videos[0], audio = audios[0];
  if (videos.length !== 1 || audios.length > 1 || !Number.isFinite(duration) || duration <= 0
    || !Number.isSafeInteger(video?.width) || video.width < 2 || !Number.isSafeInteger(video.height) || video.height < 2
    || typeof video.codec_name !== 'string' || !/^[a-z0-9_]+$/i.test(video.codec_name)
    || audio && (typeof audio.codec_name !== 'string' || !/^[a-z0-9_]+$/i.test(audio.codec_name))) fail('invalid_media', '合并输入缺少唯一视频轨、有效尺寸或时长');
  return { duration, video, audio, signature: JSON.stringify([signature(video, videoFields), signature(audio, audioFields)]) };
}

/** One instance serializes merge operations; cancellation and disposal wait for cleanup before returning. */
export class HongguoMerger {
  constructor({ tasks, subprocess, config = {} }) {
    this.tasks = tasks; this.subprocess = subprocess; this.config = resolveConfig(config);
    this.lifetime = new AbortController(); this.tail = Promise.resolve(); this.pending = new Set(); this.closing = false; this.quarantinedPath = null;
  }
  /** Merge only the original owner's verified selection; omitted episodes retain the original request. */
  merge(args, caller, signal) {
    const deadline = AbortSignal.timeout(this.config.mergeTimeoutMs);
    const active = AbortSignal.any([this.lifetime.signal, deadline, ...(signal ? [signal] : [])]);
    const work = this.tail.then(async () => {
      try {
        active.throwIfAborted();
        if (this.closing) fail('cancelled', '合并组件正在停止');
        if (this.quarantinedPath) throw mediaCleanupError(this.quarantinedPath);
        const options = argumentsFor(args, this.config);
        return await this.tasks.withStoppedTask(options.taskId, caller, active, context => this.execute(options, context, context.signal));
      } catch (error) {
        if (error.code === 'cleanup_unconfirmed') this.quarantinedPath = error.cleanupPendingPath;
        return { ok: false, complete: false, ...(active.aborted && error.code !== 'cleanup_unconfirmed'
          ? { code: 'cancelled', message: '视频合并已取消或超过时限；原始分集保留' } : safeError(error)) };
      }
    });
    this.tail = work.then(() => {}); this.pending.add(work);
    void work.then(() => this.pending.delete(work));
    return work;
  }
  async execute(options, { task, cwd, checkpoint, output }, signal) {
    const config = this.config, saved = await checkpoint.read();
    if (!saved) fail('merge_checkpoint_missing', '原下载进度不可用，未扫描目录或猜测输入');
    const seriesId = options.seriesId ?? (task.request.seriesIds.length === 1 ? task.request.seriesIds[0] : null);
    if (!seriesId || !task.request.seriesIds.includes(seriesId)) fail('invalid_arguments', '多剧下载任务需要明确选择其中一部剧');
    const plan = saved.plans.find(item => item.seriesId === seriesId);
    if (!plan) fail('merge_checkpoint_missing', '原任务中没有此剧的完整目录');
    const episodes = options.episodes ?? task.request.episodes ?? plan.episodes.map(item => item.index);
    if (!episodes.length || episodes.length > config.maxMergeEpisodes) fail('invalid_arguments', '合并集数超过 maxMergeEpisodes');
    const selected = [...episodes].sort((a, b) => a - b), sources = [];
    for (const index of selected) {
      const declared = plan.episodes.find(item => item.index === index);
      const completed = saved.completed.filter(item => item.seriesId === seriesId && item.episode.index === index && item.vid === declared?.vid);
      if (!declared || completed.length !== 1) fail('missing_episodes', '所选分集尚未全部验证完成；没有自动下载或跳过缺集');
      const episode = completed[0].episode;
      if (!await verifiedEpisode(output.path, episode, config, signal, task.request.quality)) fail('merge_input_changed', '合并输入与已验证回执不一致；原始文件保留');
      sources.push(episode);
    }
    if (sources.reduce((sum, item) => sum + item.bytes, 0) > config.maxMergeBytes) fail('merge_size', '合并输入超过 maxMergeBytes');
    const suffix = createHash('sha256').update(JSON.stringify([seriesId, selected])).digest('hex').slice(0, 12);
    const path = join(checkpoint.directory, options.outputFile ?? `merged-${suffix}.mp4`), receipt = `${path}.json`;
    await absent(path); await absent(receipt);
    signal.throwIfAborted();
    const checkpointIdentity = await lstat(checkpoint.directory, { bigint: true });
    if (!checkpointIdentity.isDirectory() || checkpointIdentity.isSymbolicLink() || await realpath(checkpoint.directory) !== checkpoint.directory) fail('unsafe_path', '合并目录包含链接或已变化');
    const stage = await mkdtemp(join(checkpoint.directory, '.merge-stage-')), stageIdentity = await lstat(stage, { bigint: true });
    let lease, leaseIdentity, unknown = false, unsafeLocation = false, linked = false, published = false, finalIdentity;
    const checkLocation = async () => {
      try {
        const directory = await lstat(checkpoint.directory, { bigint: true }), current = await lstat(stage, { bigint: true });
        if (!directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== checkpointIdentity.dev || directory.ino !== checkpointIdentity.ino
          || !current.isDirectory() || current.isSymbolicLink() || current.dev !== stageIdentity.dev || current.ino !== stageIdentity.ino
          || await realpath(checkpoint.directory) !== checkpoint.directory || await realpath(stage) !== stage) throw new Error('changed');
      } catch (error) { unsafeLocation = true; fail('unsafe_path', '合并目录已变化；没有写入或清理替换后的目录'); }
    };
    const ownedLeases = new Set();
    const retain = () => { unknown = true; this.quarantinedPath = lease ?? stage; return mediaCleanupError(this.quarantinedPath); };
    const run = async argv => {
      let handle;
      try {
        signal.throwIfAborted(); await checkLocation();
        handle = this.subprocess.spawn({ argv, cwd: stage, stdio: { stdin: 'ignore', stdout: { maxBytes: outputBytes }, stderr: { maxBytes: outputBytes } },
          signal, graceMs: config.mediaProcessGraceMs });
        const outcome = await handle.done;
        if (!await handle.waitForExit(signal)) { handle.terminate(); if (!await handle.waitForExit()) throw retain(); }
        signal.throwIfAborted(); await checkLocation();
        const streams = ['stdout', 'stderr'].map(name => handle.collected[name]?.readFrom(0));
        if (outcome.exitCode !== 0 || outcome.signal || streams.some(value => !value || value.lossy || value.truncated
          || typeof value.text !== 'string' || Buffer.byteLength(value.text) > outputBytes) || streams[1].text.trim()) {
          fail('merge_failed', '本地视频合并处理失败；原始分集保留');
        }
        return streams[0].text;
      } catch (error) {
        if (handle && !unknown) {
          let terminated = true;
          try { handle.terminate(); } catch (terminationError) { terminated = false; }
          const settled = await Promise.allSettled([handle.done, handle.waitForExit()]);
          if (!terminated || settled[1].status !== 'fulfilled' || settled[1].value !== true) throw retain();
        }
        if (unknown) throw retain();
        if (signal.aborted) throw new DownloadError('cancelled', '视频合并已取消或超过时限；原始分集保留');
        throw error instanceof DownloadError ? error : new DownloadError('merge_failed', '本地视频合并处理失败；原始分集保留');
      }
    };
    try {
      for (let index = 0; index < sources.length; index++) {
        signal.throwIfAborted();
        await checkLocation();
        const copy = join(stage, `${String(index + 1).padStart(6, '0')}.mp4`);
        await copyFile(sources[index].path, copy, constants.COPYFILE_EXCL);
        if ((await lstat(copy)).size !== sources[index].bytes || await hashFile(copy, signal) !== sources[index].sha256) fail('merge_input_changed', '复制的合并输入与回执不一致；原始文件保留');
      }
      signal.throwIfAborted();
      if (!this.subprocess || !config.ffmpegExecutable || !config.ffprobeExecutable) fail('missing_media_runtime', '合并需要有效的 FFmpeg 和 FFprobe');
      lease = await createMediaLease(checkpoint.directory, [stage, path], ownedLeases); leaseIdentity = await lstat(lease, { bigint: true });
      const ffmpeg = await this.subprocess.resolveExecutable(config.ffmpegExecutable, undefined, signal);
      const ffprobe = await this.subprocess.resolveExecutable(config.ffprobeExecutable, undefined, signal);
      const infos = [];
      for (let index = 0; index < sources.length; index++) {
        const input = join(stage, `${String(index + 1).padStart(6, '0')}.mp4`);
        infos.push(mergeInfo(await run([ffprobe, '-v', 'error', '-show_streams', '-show_format', '-show_data_hash', 'sha256', '-of', 'json',
          '-protocol_whitelist', 'file,pipe', '-i', input])));
      }
      const first = infos[0];
      const copyable = ['h264', 'hevc'].includes(first.video.codec_name) && typeof first.video.extradata_hash === 'string'
        && (!first.audio || typeof first.audio.extradata_hash === 'string') && infos.every(info => info.signature === first.signature);
      if (options.mode === 'copy' && !copyable) fail('merge_incompatible', '分集流参数不同，无法直接拼接；请使用 auto 或 compatible');
      const actualMode = options.mode === 'compatible' || !copyable ? 'compatible' : 'copy';
      const width = actualMode === 'copy' ? first.video.width : Math.min(...infos.map(info => Math.floor(info.video.width / 2) * 2));
      const height = actualMode === 'copy' ? first.video.height : Math.min(...infos.map(info => Math.floor(info.video.height / 2) * 2));
      const hasAudio = infos.some(info => info.audio), inputs = [];
      let stagingBytes = sources.reduce((sum, item) => sum + item.bytes, 0);
      for (let index = 0; index < sources.length; index++) {
        const source = `${String(index + 1).padStart(6, '0')}.mp4`;
        if (actualMode === 'copy') { inputs.push(source); continue; }
        const normalized = `normalized-${index + 1}.mp4`, info = infos[index];
        const argv = [ffmpeg, '-n', '-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file,pipe',
          '-filter_threads', '1', '-threads', String(config.mergeThreads), '-i', source];
        if (hasAudio && !info.audio) argv.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        argv.push('-map', '0:v:0');
        if (hasAudio) argv.push('-map', info.audio ? '0:a:0' : '1:a:0');
        argv.push('-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${config.mergeFrameRate}`,
          '-c:v', 'libx264', '-preset', config.mergePreset, '-crf', String(config.mergeCrf), '-pix_fmt', 'yuv420p',
          '-threads:v', String(config.mergeThreads), '-x264-params', 'lookahead_threads=1');
        if (hasAudio) argv.push('-af', 'apad', '-c:a', 'aac', '-b:a', String(config.mergeAudioBitrate), '-ar', '48000', '-ac', '2');
        else argv.push('-an');
        argv.push('-t', String(info.duration), '-movflags', '+faststart', '-fs', String(config.maxMergeBytes), '-f', 'mp4', normalized);
        await run(argv);
        const normalizedPath = join(stage, normalized), entry = await lstat(normalizedPath);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size >= config.maxMergeBytes) fail('merge_size', '合并中间文件为空或超过 maxMergeBytes');
        stagingBytes += entry.size;
        if (stagingBytes > config.maxMergeBytes) fail('merge_size', '合并暂存输入超过 maxMergeBytes');
        inputs.push(normalized);
      }
      const concat = join(stage, 'concat.txt');
      await writeFile(concat, inputs.map(name => `file '${name}'`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
      const merged = join(stage, 'merged.part');
      const concatArgs = [ffmpeg, '-n', '-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', concat,
        '-map', '0:v:0', '-map', '0:a?', '-c:v', 'copy'];
      if (actualMode === 'compatible' && hasAudio) concatArgs.push('-c:a', 'aac', '-b:a', String(config.mergeAudioBitrate), '-ar', '48000', '-ac', '2', '-af', 'aresample=async=1:first_pts=0');
      else concatArgs.push('-c:a', 'copy');
      concatArgs.push('-movflags', '+faststart', '-fs', String(config.maxMergeBytes), '-f', 'mp4', merged);
      await run(concatArgs);
      const info = await lstat(merged, { bigint: true }); finalIdentity = info;
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0n || info.size >= BigInt(config.maxMergeBytes)) fail('merge_size', '合并文件为空或超过 maxMergeBytes');
      const expectedDuration = infos.reduce((sum, item) => sum + item.duration, 0);
      const validate = createMediaProcessor(this.subprocess, { ...config, downloadTimeoutMs: config.mergeTimeoutMs });
      let facts;
      try { facts = await validate({ expectedDuration, expectedWidth: width, expectedHeight: height }, { inputPath: merged,
        outputPath: join(stage, 'unused.part'), workspace: stage, signal }); }
      catch (error) { if (error.code === 'cleanup_unconfirmed') throw retain(); throw error; }
      const durationTolerance = Math.min(config.mergeDurationToleranceMs / 1000, Math.max(2 / config.mergeFrameRate, expectedDuration * .01));
      if (Math.abs(facts.durationSeconds - expectedDuration) > durationTolerance) fail('merge_duration', '合并时长与所选分集不一致；没有发布截断或重复结果');
      if (actualMode === 'compatible' && facts.videoCodec !== 'h264') fail('merge_failed', '兼容合并结果不是 H.264');
      await validateMp4(merged); const sha256 = await hashFile(merged, signal);
      const value = { ok: true, path, receipt, sourceTaskId: task.id, seriesId, episodes: selected,
        seriesEpisodeCount: plan.episodeCount, complete: selected.length === plan.episodeCount && selected.every((index, position) => index === position + 1),
        requestedMode: options.mode, actualMode, durationSeconds: facts.durationSeconds, width: facts.width, height: facts.height,
        videoCodec: facts.videoCodec, bytes: Number(info.size), sha256, fullDecodeChecked: true, validationLevel: 'ffprobe-full-decode-sha256',
        sources: sources.map(item => ({ index: item.index, path: item.path, bytes: item.bytes, sha256: item.sha256 })) };
      await writeFile(join(stage, 'receipt.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      signal.throwIfAborted(); await output.create(); await checkLocation();
      try {
        await link(merged, path); linked = true;
        await link(join(stage, 'receipt.json'), receipt); published = true;
      } catch (error) { if (error.code === 'EEXIST') fail('output_exists', '合并目标或回执已存在；已有文件未改动'); throw error; }
      return value;
    } finally {
      if (!unknown && !unsafeLocation) {
        if (linked && !published) {
          const entry = await lstat(path, { bigint: true });
          if (entry.isFile() && !entry.isSymbolicLink() && entry.dev === finalIdentity.dev && entry.ino === finalIdentity.ino) await rm(path);
        }
        if (lease) { await removeOwned(lease, leaseIdentity); ownedLeases.delete(lease); }
        await removeOwned(stage, stageIdentity);
      }
    }
  }
  /** Refuse new work, abort queued and active operations, and await their resource cleanup. */
  async dispose() { this.closing = true; this.lifetime.abort(); await Promise.allSettled([...this.pending]); }
}
