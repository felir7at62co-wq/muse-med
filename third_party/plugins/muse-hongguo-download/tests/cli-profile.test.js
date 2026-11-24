/** Opt-in built-dsh smoke consuming the ordinary plugin tarball through a dedicated profile. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readFile, readdir, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HongguoDownloadClient, resolveConfig } from '../src/client.js';
import { DownloadCheckpoint } from '../src/checkpoint.js';
import { TaskStore } from '../src/task-store.js';

function command(bin, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', expired = false;
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, 45000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, expired, stdout, stderr }); });
  });
}

test('ordinary packed CLI boots through built dsh without an Agent or account surface', async t => {
  const tgz = process.env.MUSE_HONGGUO_CLI_TGZ, bin = process.env.MUSE_HONGGUO_BUILT_CLI;
  if (!tgz || !bin) { t.skip('set MUSE_HONGGUO_CLI_TGZ and MUSE_HONGGUO_BUILT_CLI for packed profile acceptance'); return; }
  const root = await mkdtemp(join(tmpdir(), 'hongguo-packed-cli-')), home = join(root, 'home'), cwd = join(root, 'workspace');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(cwd);
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
  const installed = await command(resolve(bin), ['plugin', '--profile', 'hongguo', 'add', '--offline', '--ignore-scripts', resolve(tgz)], cwd, env);
  assert.equal(installed.expired, false); assert.equal(installed.code, 0, installed.stderr.slice(-3000));
  const profile = join(home, 'profiles', 'hongguo');
  await copyFile(join(profile, 'node_modules', 'muse-hongguo-download', 'profiles', 'hongguo', 'cordis.patch.yml'), join(profile, 'cordis.patch.yml'));
  const help = await command(resolve(bin), ['--profile', 'hongguo', '--help'], cwd, env);
  assert.equal(help.expired, false); assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /Usage: dsh --profile hongguo/);
  assert.equal((await readdir(profile)).includes('hongguo-cli-operator.json'), false);
  const rejected = await command(resolve(bin), ['--profile', 'hongguo', 'download', '--series', '1', '--quality', '480p'], cwd, env);
  assert.equal(rejected.code, 2, rejected.stderr);
  assert.equal((await readdir(profile)).includes('hongguo-cli-operator.json'), false);
  const list = await command(resolve(bin), ['--profile', 'hongguo', 'jobs', '--json'], cwd, env);
  assert.equal(list.expired, false); assert.equal(list.code, 0, list.stderr);
  const result = JSON.parse(list.stdout);
  assert.equal(result.ok, true);
  const defaultPolicy = await command(resolve(bin), ['--profile', 'hongguo', 'download', '--series', '1', '--output', '../outside'], cwd, env);
  assert.equal(defaultPolicy.code, 1, defaultPolicy.stderr);
  assert.equal(JSON.parse(defaultPolicy.stdout).code, 'unsafe_path', 'default workspace-write must reach the path guard rather than fail as read-only');
  const readOnly = await command(resolve(bin), ['--profile', 'hongguo', 'download', '--series', '1', '--permission-mode', 'read-only'], cwd, env);
  assert.equal(readOnly.code, 1, readOnly.stderr);
  assert.equal(JSON.parse(readOnly.stdout).code, 'file_access_denied');
  const identity = JSON.parse(await readFile(join(profile, 'hongguo-cli-operator.json'), 'utf8'));
  assert.equal(identity.version, 1);
  const canonicalCwd = await realpath(cwd), policy = { mode: 'workspace-write', workspaceRoot: canonicalCwd };
  const fixtureClient = new HongguoDownloadClient();
  const spec = await fixtureClient.resolveTaskRequest({ seriesIds: ['10001'], quality: 'auto' }, canonicalCwd, policy);
  await fixtureClient.dispose();
  const folder = join(spec.checkpointDirectory, "CLI verified cache fixture's");
  await mkdir(folder, { recursive: true });
  const ffmpeg = process.env.MUSE_HONGGUO_TEST_FFMPEG ?? 'ffmpeg', episodes = [];
  for (const [offset, color] of ['blue', 'red'].entries()) {
    const index = offset + 1, media = join(folder, `${String(index).padStart(4, '0')}.mp4`);
    const encoded = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=10:d=1`, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media], { encoding: 'utf8' });
    assert.equal(encoded.status, 0, encoded.stderr);
    const decoded = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-i', media, '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(decoded.status, 0, decoded.stderr);
    const bytes = await readFile(media), sha256 = createHash('sha256').update(bytes).digest('hex');
    episodes.push({ index, title: `codec fixture ${index}`, path: media, bytes: bytes.length, sha256,
      durationSeconds: 1, sourceBytes: bytes.length, sourceSha256: sha256, encryptedSource: false,
      width: 160, height: 90, quality: '90p', videoCodec: 'h264', format: 'mp4', validationLevel: 'ffprobe-full-decode-sha256', fullDecodeChecked: true });
  }
  await writeFile(join(spec.checkpointDirectory, 'download-manifest.json'), JSON.stringify({ ok: true, sourceMode: 'legacy',
    sourceIdentity: spec.sourceIdentity, requestedQuality: 'auto', complete: true, items: [{ seriesId: '10001', title: 'CLI verified cache fixture',
      source: 'local-codec-test-fixture', episodeCount: 2, downloadedEpisodeCount: 2, complete: true, path: folder, episodes }] }));
  const taskId = `hgt-${randomUUID().replaceAll('-', '')}`, previousRunId = `hgr-${randomUUID().replaceAll('-', '')}`;
  const store = new TaskStore(canonicalCwd, resolveConfig()), at = new Date().toISOString();
  await store.change(taskId, () => ({ version: 1, kind: 'download', id: taskId, owner: { kind: 'cli', id: identity.id }, cwd: canonicalCwd,
    request: spec.request, sourceIdentity: spec.sourceIdentity, checkpointDirectory: spec.checkpointDirectory,
    state: 'paused', runId: previousRunId, runnerPid: null, jobId: null, revision: 0, progress: null, summary: null, createdAt: at, updatedAt: at }));

  const oldTaskId = `hgt-${randomUUID().replaceAll('-', '')}`;
  const oldIdentity = 'jackotom:8d14d07b3aaf99ecbe6b3ecb8ba2d0308261845d:auto';
  const oldCheckpoint = new DownloadCheckpoint(spec.request.outputDir, {
    mode: 'legacy', seriesIds: spec.request.seriesIds, episodes: null, sourceIdentity: oldIdentity,
  }, resolveConfig());
  const oldTask = await store.change(oldTaskId, () => ({
    version: 1, kind: 'download', id: oldTaskId, owner: { kind: 'cli', id: identity.id }, cwd: canonicalCwd,
    request: spec.request, sourceIdentity: oldIdentity, checkpointDirectory: oldCheckpoint.directory,
    state: 'paused', runId: null, runnerPid: null, jobId: null, revision: 0, progress: null, summary: null, createdAt: at, updatedAt: at,
  }));
  const rejectedResume = await command(resolve(bin), ['--profile', 'hongguo', 'resume', oldTaskId], cwd, env);
  assert.equal(rejectedResume.code, 1, rejectedResume.stderr);
  assert.equal(JSON.parse(rejectedResume.stdout).code, 'task_source_changed');
  assert.deepEqual(await store.read(oldTaskId), oldTask);

  const resumed = await command(resolve(bin), ['--profile', 'hongguo', 'resume', taskId], cwd, env);
  assert.equal(resumed.expired, false); assert.equal(resumed.code, 0, resumed.stderr);
  const completed = JSON.parse(resumed.stdout);
  assert.equal(completed.ok, true, resumed.stdout); assert.equal(completed.state, 'completed');
  assert.equal(completed.reusedEpisodeCount, 2); assert.equal(completed.newlyDownloadedEpisodeCount, 0);
  assert.notEqual(completed.runId, previousRunId);
  assert.deepEqual(completed.task.owner, { kind: 'cli', id: identity.id });
  assert.equal((await store.read(taskId)).state, 'completed');
  const locate = name => {
    const located = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
    assert.equal(located.status, 0, `required media test tool: ${name}`);
    return resolve(located.stdout.trim().split(/\r?\n/)[0]);
  };
  env.MUSE_HONGGUO_FFMPEG_PATH = locate(ffmpeg);
  env.MUSE_HONGGUO_FFPROBE_PATH = locate(process.env.MUSE_HONGGUO_TEST_FFPROBE ?? 'ffprobe');
  const deniedMerge = await command(resolve(bin), ['--profile', 'hongguo', 'merge', taskId,
    '--permission-mode', 'read-only', '--output', 'read-only.mp4'], cwd, env);
  assert.equal(deniedMerge.code, 1, deniedMerge.stderr);
  assert.equal(JSON.parse(deniedMerge.stdout).code, 'file_access_denied');
  await assert.rejects(readFile(join(spec.checkpointDirectory, 'read-only.mp4')), { code: 'ENOENT' });
  const merge = await command(resolve(bin), ['--profile', 'hongguo', 'merge', taskId, '--series', '10001', '--episodes', '2,1', '--mode', 'auto', '--output', 'cli-combined.mp4'], cwd, env);
  assert.equal(merge.expired, false); assert.equal(merge.code, 0, merge.stderr);
  const merged = JSON.parse(merge.stdout);
  assert.equal(merged.ok, true, merge.stdout);
  assert.equal(merged.fullDecodeChecked, true);
  assert.deepEqual(merged.episodes, [1, 2], 'the task library orders selected episodes numerically');
  assert.equal(merged.actualMode, 'copy');
  assert.equal(merged.path, join(spec.checkpointDirectory, 'cli-combined.mp4'));
  assert.equal(createHash('sha256').update(await readFile(merged.path)).digest('hex'), merged.sha256);
  const pixel = time => {
    const sampled = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', merged.path,
      '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    assert.equal(sampled.status, 0, sampled.stderr.toString());
    assert.equal(sampled.stdout.length, 3);
    return sampled.stdout;
  };
  const firstFrame = pixel(.2), secondFrame = pixel(1.2);
  assert.ok(firstFrame[2] > firstFrame[0] + 100, 'the first episode remains blue in the merged video');
  assert.ok(secondFrame[0] > secondFrame[2] + 100, 'the second episode remains red in the merged video');
  for (const episode of episodes) assert.equal(createHash('sha256').update(await readFile(episode.path)).digest('hex'), episode.sha256, 'merge keeps the original episode bytes');
  const mergeAgain = await command(resolve(bin), ['--profile', 'hongguo', 'merge', taskId, '--output', 'cli-combined.mp4'], cwd, env);
  assert.equal(mergeAgain.code, 1, mergeAgain.stderr);
  assert.equal(JSON.parse(mergeAgain.stdout).ok, false, 'an existing merge destination is never replaced');
  const missing = await command(resolve(bin), ['--profile', 'hongguo', 'merge', taskId, '--episodes', '1,2,3', '--output', 'missing.mp4'], cwd, env);
  assert.equal(missing.code, 1, missing.stderr); assert.equal(JSON.parse(missing.stdout).code, 'missing_episodes');
  await assert.rejects(readFile(join(spec.checkpointDirectory, 'missing.mp4')), { code: 'ENOENT' });
  let sessions = [];
  try { sessions = await readdir(join(home, 'sessions'), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(sessions.some(path => /session\.v\d+\.jsonl/.test(path)), false);
});
