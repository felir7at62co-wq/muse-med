/** Offline merge checks use real MP4 encoding, task ownership and complete decode verification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HongguoMerger } from '../src/merger.js';
import { HongguoDownloadClient } from '../src/client.js';
import { HongguoTasks } from '../src/tasks.js';
import { TaskStore } from '../src/task-store.js';
import { DownloadCheckpoint } from '../src/checkpoint.js';
import { resolveConfig } from '../src/config.js';
const ffmpeg = process.env.MUSE_HONGGUO_TEST_FFMPEG ?? 'ffmpeg', ffprobe = process.env.MUSE_HONGGUO_TEST_FFPROBE ?? 'ffprobe';
const haveMedia = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync(ffprobe, ['-version'], { stdio: 'ignore' }).status === 0;
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const native = () => ({
  calls: [], failures: [],
  async resolveExecutable(path, _cwd, signal) { signal.throwIfAborted(); return path; },
  spawn(spec) {
    this.calls.push(spec);
    const [bin, ...args] = spec.argv, child = spawn(bin, args, { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'], signal: spec.signal });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    const done = new Promise(resolve => { child.once('error', () => {}); child.once('close', (code, signal) => { if (code) this.failures.push({argv:spec.argv,stderr}); resolve({ exitCode: code, signal }); }); });
    return { done, terminate() { child.kill('SIGTERM'); }, async waitForExit() { await done; return true; },
      collected: { stdout: { readFrom: () => ({ text: stdout, lossy: false, truncated: false }) }, stderr: { readFrom: () => ({ text: stderr, lossy: false, truncated: false }) } } };
  },
});
async function fixture(t, clips = [{ color: 'blue' }, { color: 'red' }], overrides = {}, options = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'muse-hongguo-merge-')));
  const config = resolveConfig({ ffmpegExecutable: ffmpeg.startsWith('/') ? ffmpeg : '/usr/bin/unused-ffmpeg', ffprobeExecutable: ffprobe.startsWith('/') ? ffprobe : '/usr/bin/unused-ffprobe', ...overrides });
  const subprocess = native();
  subprocess.resolveExecutable = async (path, _cwd, signal) => { signal.throwIfAborted(); return path === config.ffmpegExecutable ? ffmpeg : ffprobe; };
  const client = new HongguoDownloadClient(config), tasks = new HongguoTasks(config, { client });
  const caller = { kind: 'cli', operatorId: 'merge-test', cwd, policy: { mode: 'workspace-write', workspaceRoot: cwd } };
  const spec = await client.resolveTaskRequest({ seriesIds: ['10001'], ...(options.selectAll ? {} : { episodes: clips.map((_clip, index) => index + 1) }), quality: 'auto' }, cwd, caller.policy);
  await mkdir(spec.request.outputDir, { recursive: true });
  const checkpoint = new DownloadCheckpoint(spec.request.outputDir, { mode: 'legacy', seriesIds: ['10001'], episodes: spec.request.episodes ?? null, sourceIdentity: spec.sourceIdentity }, config);
  const folder = await checkpoint.folder('codec-fixture'), completed = [];
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index], path = join(folder, `${index + 1}.mp4`);
    const args = ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${clip.color}:s=${clip.size ?? '160x90'}:r=10:d=1`];
    if (clip.audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1');
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
    if (clip.audio) args.push('-c:a', 'aac'); else args.push('-an');
    args.push(path);
    const encoded = spawnSync(ffmpeg, args, { encoding: 'utf8' }); assert.equal(encoded.status, 0, encoded.stderr);
    const full = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' }); assert.equal(full.status, 0, full.stderr);
    const bytes = await readFile(path), [width, height] = (clip.size ?? '160x90').split('x').map(Number);
    completed.push({ seriesId: '10001', vid: String(index + 1), episode: { index: index + 1, path, title: String(index + 1),
      bytes: bytes.length, sha256: sha(bytes), durationSeconds: 1, width, height, fullDecodeChecked: true, validationLevel: 'ffprobe-full-decode-sha256' } });
  }
  const state = { version: 1, request: checkpoint.request, plans: [{ seriesId: '10001', title: 'codec', source: 'fixture', episodeCount: options.declaredCount ?? clips.length,
    episodes: Array.from({ length: options.declaredCount ?? clips.length }, (_item, index) => ({ index: index + 1, vid: String(index + 1), title: String(index + 1), durationSeconds: 1 })) }], completed };
  await checkpoint.save(state);
  const taskId = 'hgt-' + '1'.repeat(32), store = new TaskStore(cwd, config), at = new Date().toISOString();
  await store.change(taskId, () => ({ version: 1, kind: 'download', id: taskId, owner: { kind: 'cli', id: caller.operatorId }, cwd,
    request: spec.request, sourceIdentity: spec.sourceIdentity, checkpointDirectory: checkpoint.directory, state: 'completed', revision: 0,
    runId: null, runnerPid: null, jobId: null, progress: null, summary: null, createdAt: at, updatedAt: at }));
  const merger = new HongguoMerger({ tasks, subprocess, config });
  t.after(async () => { await merger.dispose(); await tasks.dispose(); await client.dispose(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, config, subprocess, client, tasks, caller, checkpoint, state, store, taskId, merger, clips: completed.map(item => item.episode) };
}

test('same-stream copy sorts selected episodes and preserves source pixels and hashes', { skip: !haveMedia }, async t => {
  const f = await fixture(t);
  const result = await f.merger.merge({ taskId: f.taskId, episodes: [2, 1], outputFile: 'copy.mp4' }, f.caller);
  assert.equal(result.ok, true, JSON.stringify({ result, failures: f.subprocess.failures })); assert.equal(result.actualMode, 'copy'); assert.deepEqual(result.episodes, [1, 2]);
  assert.equal(result.fullDecodeChecked, true); assert.equal(result.sha256, sha(await readFile(result.path)));
  assert.deepEqual(JSON.parse(await readFile(result.receipt, 'utf8')), result);
  for (const [time, channel] of [[.25, 2], [1.25, 0]]) {
    const sample = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', result.path, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    assert.equal(sample.status, 0); assert.ok(sample.stdout[channel] > 200);
  }
  for (const clip of f.clips) assert.equal(sha(await readFile(clip.path)), clip.sha256);
  const again = await f.merger.merge({ taskId: f.taskId, outputFile: 'copy.mp4' }, f.caller);
  assert.equal(again.code, 'output_exists');
});

test('auto normalizes mixed sizes and missing audio without changing originals', { skip: !haveMedia }, async t => {
  const f = await fixture(t, [{ color: 'blue', audio: true }, { color: 'red', size: '320x180' }]);
  const refused = await f.merger.merge({ taskId: f.taskId, mode: 'copy', outputFile: 'strict.mp4' }, f.caller);
  assert.equal(refused.code, 'merge_incompatible');
  const result = await f.merger.merge({ taskId: f.taskId, outputFile: 'compatible.mp4' }, f.caller);
  assert.equal(result.ok, true, JSON.stringify({ result, failures: f.subprocess.failures })); assert.equal(result.actualMode, 'compatible');
  assert.equal(result.videoCodec, 'h264'); assert.equal(result.width, 160); assert.equal(result.height, 90);
  const probe = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', result.path], { encoding: 'utf8' });
  const audio = JSON.parse(probe.stdout).streams.find(item => item.codec_type === 'audio');
  assert.equal(audio.codec_name, 'aac'); assert.equal(audio.channels, 2); assert.equal(audio.sample_rate, '48000');
  assert.ok(Math.abs(result.durationSeconds - 2) < .2);
  for (const clip of f.clips) assert.equal(sha(await readFile(clip.path)), clip.sha256);
});

test('compatible mode retains no-audio clips without inventing an audio track', { skip: !haveMedia }, async t => {
  const f = await fixture(t);
  const result = await f.merger.merge({ taskId: f.taskId, mode: 'compatible' }, f.caller);
  assert.equal(result.ok, true, JSON.stringify({ result, failures: f.subprocess.failures }));
  const probe = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', result.path], { encoding: 'utf8' });
  assert.equal(JSON.parse(probe.stdout).streams.some(item => item.codec_type === 'audio'), false);
});

test('missing episodes, duplicate selections, changed bytes and foreign/read-only owners never start native merge', { skip: !haveMedia }, async t => {
  const f = await fixture(t);
  for (const [options, caller, code] of [
    [{ episodes: [1, 3] }, f.caller, 'missing_episodes'], [{ episodes: [1, 1] }, f.caller, 'invalid_arguments'],
    [{}, { ...f.caller, operatorId: 'foreign' }, 'task_forbidden'], [{}, { ...f.caller, policy: { mode: 'read-only' } }, 'file_access_denied'],
    [{ outputFile: '../outside.mp4' }, f.caller, 'invalid_arguments'],
  ]) assert.equal((await f.merger.merge({ taskId: f.taskId, ...options }, caller)).code, code);
  const bytes = await readFile(f.clips[1].path); bytes[bytes.length - 1] ^= 1; await writeFile(f.clips[1].path, bytes);
  assert.equal((await f.merger.merge({ taskId: f.taskId }, f.caller)).code, 'merge_input_changed');
  assert.equal(f.subprocess.calls.length, 0);
});

test('source checkpoint writer lock excludes a different task operation', { skip: !haveMedia }, async t => {
  const f = await fixture(t), held = defer(), release = defer();
  const locking = f.checkpoint.locked(async () => { held.resolve(); await release.promise; });
  await held.promise;
  const refused = await f.merger.merge({ taskId: f.taskId }, f.caller);
  assert.equal(refused.code, 'download_in_progress'); assert.equal(f.subprocess.calls.length, 0);
  release.resolve(); await locking;
});

test('cancelled queued work never acquires an input or starts a subprocess', { skip: !haveMedia }, async t => {
  const f = await fixture(t), gate = defer(), active = new AbortController();
  f.merger.tail = gate.promise;
  const merging = f.merger.merge({ taskId: f.taskId }, f.caller, active.signal);
  active.abort(new Error('caller stop')); gate.resolve();
  assert.equal((await merging).code, 'cancelled'); assert.equal(f.subprocess.calls.length, 0);
});

test('unknown native exit retains process lease and copied inputs and blocks restart', { skip: !haveMedia }, async t => {
  const f = await fixture(t);
  f.subprocess.spawn = () => ({ done: Promise.resolve({ exitCode: 1, signal: null }), terminate() {}, waitForExit: async () => false,
    collected: { stdout: { readFrom: () => ({ text: '', lossy: false, truncated: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false, truncated: false }) } } });
  const result = await f.merger.merge({ taskId: f.taskId }, f.caller);
  assert.equal(result.code, 'cleanup_unconfirmed');
  assert.ok((await readdir(f.checkpoint.directory)).some(name => name.startsWith('.merge-stage-')));
  assert.ok((await readdir(f.checkpoint.directory)).some(name => name.startsWith('.media-process-')));
  const restarted = new HongguoMerger({ tasks: f.tasks, subprocess: native(), config: f.config });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.merge({ taskId: f.taskId }, f.caller)).code, 'cleanup_unconfirmed');
});


test('omitted whole-series selection refuses a missing declared episode instead of skipping it', { skip: !haveMedia }, async t => {
  const f = await fixture(t, [{ color: 'blue' }, { color: 'red' }], {}, { selectAll: true, declaredCount: 3 });
  const result = await f.merger.merge({ taskId: f.taskId }, f.caller);
  assert.equal(result.code, 'missing_episodes'); assert.equal(f.subprocess.calls.length, 0);
  const explicit = await f.merger.merge({ taskId: f.taskId, episodes: [2, 1] }, f.caller);
  assert.equal(explicit.ok, true, JSON.stringify(explicit)); assert.equal(explicit.complete, false); assert.equal(explicit.seriesEpisodeCount, 3);
});

test('active cancellation waits for confirmed native exit before removing copied inputs', { skip: !haveMedia }, async t => {
  const f = await fixture(t), began = defer(), stopped = defer(), cleanup = defer(), controller = new AbortController();
  f.subprocess.spawn = spec => {
    began.resolve();
    spec.signal.addEventListener('abort', () => stopped.resolve({ exitCode: 1, signal: 'SIGTERM' }), { once: true });
    return { done: stopped.promise, terminate() {}, waitForExit: async () => { await cleanup.promise; return true; },
      collected: { stdout: { readFrom: () => ({ text: '', lossy: false, truncated: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false, truncated: false }) } } };
  };
  let settled = false;
  const merging = f.merger.merge({ taskId: f.taskId }, f.caller, controller.signal).then(value => { settled = true; return value; });
  await began.promise; controller.abort(); await stopped.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.ok((await readdir(f.checkpoint.directory)).some(name => name.startsWith('.merge-stage-')));
  cleanup.resolve(); assert.equal((await merging).code, 'cancelled');
  assert.equal((await readdir(f.checkpoint.directory)).some(name => name.startsWith('.media-process-') || name.startsWith('.merge-stage-')), false);
});

test('checkpoint replacement during native work cannot publish or clean the replacement directory', { skip: !haveMedia || process.platform === 'win32' }, async t => {
  const f = await fixture(t), outside = await mkdtemp(join(tmpdir(), 'muse-merge-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const nativeSpawn = f.subprocess.spawn.bind(f.subprocess);
  f.subprocess.spawn = spec => {
    const handle = nativeSpawn(spec);
    if (spec.argv.includes('concat')) {
      const done = handle.done;
      handle.done = (async () => {
        const value = await done;
        await rename(f.checkpoint.directory, f.checkpoint.directory + '-retained');
        await symlink(outside, f.checkpoint.directory, 'dir');
        return value;
      })();
    }
    return handle;
  };
  const result = await f.merger.merge({ taskId: f.taskId, outputFile: 'outside.mp4' }, f.caller);
  assert.equal(result.ok, false); assert.equal(result.code, 'unsafe_path'); assert.deepEqual(await readdir(outside), []);
  assert.ok((await readdir(f.checkpoint.directory + '-retained')).some(name => name.startsWith('.merge-stage-')));
});


test('a fully decodable truncated merge cannot pass the short-video duration check', { skip: !haveMedia }, async t => {
  const f = await fixture(t), nativeSpawn = f.subprocess.spawn.bind(f.subprocess);
  f.subprocess.spawn = spec => {
    if (!spec.argv.includes('concat')) return nativeSpawn(spec);
    return nativeSpawn({ ...spec, argv: [ffmpeg, '-v', 'error', '-i', join(spec.cwd, '000001.mp4'), '-c', 'copy', '-f', 'mp4', spec.argv.at(-1)] });
  };
  const result = await f.merger.merge({ taskId: f.taskId, outputFile: 'truncated.mp4' }, f.caller);
  assert.equal(result.code, 'merge_duration');
  assert.equal((await readdir(f.checkpoint.directory)).includes('truncated.mp4'), false);
});
