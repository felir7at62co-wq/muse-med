/** Cross-process recovery must retain live exclusions and survive the reclaimer's own death. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { TaskStore } from '../src/task-store.js';
import { resolveConfig } from '../src/runner.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'douyin-registry-lock-'));
  const directory = join(home, 'plugin-data/muse-douyin-download/tasks/v1');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const children = new Set();
  t.after(async () => {
    await Promise.all([...children].map(async child => { if (child.exitCode === null) child.kill(); await child.done; }));
    await rm(home, { recursive: true, force: true });
  });
  const child = mode => {
    const process = fork(new URL('./registry-lock-child.js', import.meta.url), [home, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.add(process);
    let errors = '';
    process.stderr.on('data', chunk => { errors += chunk; });
    process.done = new Promise((resolve, reject) => { process.once('error', reject); process.once('exit', (code, signal) => code === 0 || signal ? resolve() : reject(new Error(errors || `child exit ${code}`))); });
    process.stage = new Promise((resolve, reject) => { process.once('message', resolve); process.done.then(() => reject(new Error('child exited before stage')), reject); });
    // Some modes exit without a staged handshake.
    void process.stage.catch(() => {});
    return process;
  };
  const store = () => new TaskStore(resolveConfig({ settingsHome: home }));
  // Rejection controls deliberately expire; successful recovery uses the deployment budget.
  const blockedStore = () => new TaskStore(resolveConfig({ settingsHome: home, taskLockTimeoutMs: 100, taskLockPollMs: 2 }));
  return { home, directory, child, store, blockedStore };
}

test('recovers when a real dead-owner reclaimer exits after publishing its guard', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const original = f.child('crash-primary');
  assert.deepEqual(await original.stage, { stage: 'primary-held' }); await original.done;
  const reclaimer = f.child('crash-reclaimer');
  assert.deepEqual(await reclaimer.stage, { stage: 'reclaim-held' }); await reclaimer.done;
  await f.store().ready();
  await assert.rejects(lstat(join(f.directory, '.registry.reclaim')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.directory, '.registry.lock')), { code: 'ENOENT' });
});

test('does not reclaim a live primary writer or live reclaimer', { timeout: 10000 }, async t => {
  const f = await fixture(t), primary = f.child('hold-primary');
  await primary.stage;
  const before = await readFile(join(f.directory, '.registry.lock'));
  await assert.rejects(f.blockedStore().ready(), { code: 'DOUYIN_TASK_LOCKED' });
  assert.deepEqual(await readFile(join(f.directory, '.registry.lock')), before);
  primary.send('release'); await primary.done;
  const dead = f.child('crash-primary'); await dead.stage; await dead.done;
  const reclaimer = f.child('hold-reclaimer'); await reclaimer.stage;
  const guard = await readFile(join(f.directory, '.registry.reclaim'));
  await assert.rejects(f.blockedStore().ready(), { code: 'DOUYIN_TASK_LOCKED' });
  assert.deepEqual(await readFile(join(f.directory, '.registry.reclaim')), guard);
  reclaimer.send('release'); await reclaimer.done;
  await f.store().ready();
});

for (const mode of ['hold-primary', 'hold-reclaimer']) test(`releases ${mode} after its owning test disconnects`, { timeout: 10000 }, async t => {
  const f = await fixture(t);
  if (mode === 'hold-reclaimer') { const dead = f.child('crash-primary'); await dead.stage; await dead.done; }
  const held = f.child(mode);
  await held.stage;
  held.disconnect();
  await held.done;
  assert.equal(held.exitCode, 0);
  await f.store().ready();
  await assert.rejects(lstat(join(f.directory, '.registry.lock')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.directory, '.registry.reclaim')), { code: 'ENOENT' });
});

test('keeps an anonymous legacy guard and its dead primary untouched', { timeout: 10000 }, async t => {
  const f = await fixture(t), dead = f.child('crash-primary'); await dead.stage; await dead.done;
  const original = await readFile(join(f.directory, '.registry.lock'));
  await writeFile(join(f.directory, '.registry.reclaim'), '', { flag: 'wx', mode: 0o600 });
  await assert.rejects(f.blockedStore().ready(), { code: 'DOUYIN_TASK_LOCKED' });
  assert.deepEqual(await readFile(join(f.directory, '.registry.lock')), original);
  assert.equal((await lstat(join(f.directory, '.registry.reclaim'))).size, 0);
});

test('refuses incomplete legacy primary and malformed recovery ownership', { timeout: 10000 }, async t => {
  const f = await fixture(t), file = join(f.directory, '.registry.lock');
  await writeFile(file, '', { flag: 'wx', mode: 0o600 });
  await assert.rejects(f.blockedStore().ready(), { code: 'DOUYIN_TASK_LOCKED' });
  assert.equal((await lstat(file)).size, 0);
  await rm(file);
  const dead = f.child('crash-primary'); await dead.stage; await dead.done;
  const original = await readFile(file), owner = JSON.parse(original);
  await writeFile(join(f.directory, '.registry.reclaim'), JSON.stringify({ ...owner, format: 'muse-douyin-reclaim.v2', token: 'incomplete' }), { flag: 'wx', mode: 0o600 });
  await assert.rejects(f.blockedStore().ready(), { code: 'DOUYIN_TASK_LOCKED' });
  assert.deepEqual(await readFile(file), original);
  assert.equal(JSON.parse(await readFile(join(f.directory, '.registry.reclaim'))).token, 'incomplete');
});

test('serializes independent process transactions after a reclaimer crash', { timeout: 15000 }, async t => {
  const f = await fixture(t), dead = f.child('crash-primary'); await dead.stage; await dead.done;
  const reclaimer = f.child('crash-reclaimer'); await reclaimer.stage; await reclaimer.done;
  await Promise.all(Array.from({ length: 3 }, () => f.child('increment').done));
  const store = f.store(); store.file = join(f.directory, 'registry.json');
  const registry = await store.read();
  assert.equal(registry.revision, 12);
  assert.deepEqual(registry.tasks, []);
});

for (const mode of ['primary', 'reclaimer']) test(`retains published ${mode} ownership when private temporary cleanup fails`, { timeout: 10000 }, async t => {
  const f = await fixture(t);
  if (mode === 'reclaimer') { const dead = f.child('crash-primary'); await dead.stage; await dead.done; }
  await f.child('cleanup-' + mode).done;
  await f.store().ready();
  await assert.rejects(lstat(join(f.directory, '.registry.lock')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.directory, '.registry.reclaim')), { code: 'ENOENT' });
});

for (const [label, corrupt] of [
  ['missing token', record => { delete record.token; }],
  ['missing Host identity', record => { delete record.hostInstance; }],
  ['negative PID', record => { record.pid = -record.pid; }],
  ['out-of-range PID', record => { record.pid = 0x80000000; }],
  ['unknown owner field', record => { record.unknown = true; }],
]) test(`retains a persisted primary with ${label} instead of inferring a dead owner`, { timeout: 10000 }, async t => {
  const f = await fixture(t), dead = f.child('crash-primary');
  await dead.stage; await dead.done;
  const file = join(f.directory, '.registry.lock');
  const record = JSON.parse(await readFile(file, 'utf8'));
  corrupt(record);
  const bytes = JSON.stringify(record);
  await writeFile(file, bytes);
  await assert.rejects(f.blockedStore().ready(), { code: 'DOUYIN_TASK_LOCKED' });
  assert.equal(await readFile(file, 'utf8'), bytes);
  await assert.rejects(lstat(join(f.directory, '.registry.reclaim')), { code: 'ENOENT' });
});
