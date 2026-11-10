/** Canonical task workspaces stay bound while a real scoped Agent waits for execution. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { taskHarness } from './task-harness.js';
import { mediaReceipt, VIDEO_ONE, VIDEO_TWO, videoURL } from './task-fixtures.js';

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

test('rejects a queued task whose workspace link now resolves to another writable project before acquisition', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await taskHarness(t, { async acquireVideo(agent, url) {
    if (url === videoURL(VIDEO_ONE)) { entered.resolve(); await release.promise; }
    return mediaReceipt(agent, url);
  } });
  f.releases.add(() => release.resolve());
  const original = join(f.workspace, 'project-a'), replacement = join(f.workspace, 'project-b'), selected = join(f.workspace, 'selected-project');
  await mkdir(original); await mkdir(replacement); await symlink(original, selected, linkType);
  const owner = await f.makeAgent('queued-workspace-owner', selected);
  const first = await f.download({ url: videoURL(VIDEO_ONE), publicOnly: true, mode: 'background' });
  await entered.promise;
  const queued = await f.download({ url: videoURL(VIDEO_TWO), publicOnly: true, mode: 'background' }, { agent: owner.agent });
  assert.equal((await f.control({ action: 'status', taskId: queued.downloadTask.id }, owner.agent)).task.cwd, original);
  await unlink(selected); await symlink(replacement, selected, linkType);
  release.resolve();
  await Promise.all([f.settle(first), f.ctx.jobs.wait(queued.downloadTask.jobId, 30000, owner.agent.id)]);
  const registry = JSON.parse(await readFile(join(f.settingsHome, 'plugin-data/muse-douyin-download/tasks/v1/registry.json'), 'utf8'));
  const saved = registry.tasks.find(task => task.id === queued.downloadTask.id);
  assert.equal(saved.state, 'interrupted');
  assert.equal(saved.error.code, 'DOUYIN_TASK_FORBIDDEN');
  assert.deepEqual(f.calls.map(call => call.url), [videoURL(VIDEO_ONE)]);
  assert.deepEqual(await readdir(original), []);
  assert.deepEqual(await readdir(replacement), []);
});


test('passes the accepted canonical workspace to acquisition while retaining the exact live Agent', async t => {
  const f = await taskHarness(t, { acquireVideo: (agent, url, _publicOnly, _signal, transport) => {
    assert.equal(agent, owner.agent);
    assert.equal(transport.cwd, original);
    return mediaReceipt(agent, url);
  } });
  const original = join(f.workspace, 'project-a'), selected = join(f.workspace, 'selected-project');
  await mkdir(original); await symlink(original, selected, linkType);
  const owner = await f.makeAgent('stable-workspace-owner', selected);
  const result = await f.download({ url: videoURL(VIDEO_TWO), publicOnly: true }, { agent: owner.agent });
  assert.equal(result.status, 'downloaded');
  assert.equal(result.downloadTask.state, 'completed');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.control({ action: 'status', taskId: result.downloadTask.id }, owner.agent)).task.cwd, original);
});
