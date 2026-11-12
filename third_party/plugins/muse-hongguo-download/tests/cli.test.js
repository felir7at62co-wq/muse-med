/** CLI parsing, operator identity and safe control targeting; no model or platform requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCliArguments, readCliOperator, executeCliCommand, apply } from '../src/cli.js';

const taskId = `hgt-${'a'.repeat(32)}`, runId = `hgr-${'b'.repeat(32)}`, oldRunId = `hgr-${'c'.repeat(32)}`;
const signal = () => new AbortController().signal;
const caller = { kind: 'cli', operatorId: 'operator', cwd: '/workspace', policy: { mode: 'workspace-write', workspaceRoot: '/workspace' } };
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('parse a foreground selection without losing opaque decimal IDs or quality', () => {
  const parsed = parseCliArguments(['download', '-s', '7702841940475120702', '--series', '7702841940475120703', '--episodes', '1,3,5', '-q', '720p', '-o', 'downloads']);
  assert.equal(parsed.command, 'download');
  assert.deepEqual(parsed.download, { seriesIds: ['7702841940475120702', '7702841940475120703'], episodes: [1, 3, 5], quality: '720p', outputDir: 'downloads' });
  assert.equal(parsed.permissionMode, 'workspace-write');
  assert.equal(parseCliArguments(['jobs', '--permission-mode', 'read-only']).permissionMode, 'read-only');
  assert.equal(parseCliArguments(['jobs']).command, 'list');
  assert.deepEqual(parseCliArguments(['--help']), { command: 'help' });
});

test('invalid and irrelevant flags fail before library calls', () => {
  for (const args of [[], ['unknown'], ['download'], ['download', '-s', '1', '-q', '480p'], ['download', '-s', '1', '--episodes', '1,1'],
    ['download', '-s', '1', '--episodes', '0'], ['download', '-s', '1', '--episodes', '1-999999999'], ['download', '-s', '1', '-s', '1'],
    ['status'], ['status', 'one', 'two'], ['status', 'one', '--quality', '720p'], ['jobs', '--series', '1'],
    ['info', '-s', '1', '--episodes', '1'], ['download', '-s', '1', '--owner-session', 'session'], ['cancel', 'one', '--permission-mode', 'full'], ['cancel', 'one', '--run-id', ''], ['jobs', '--unknown']]) {
    assert.throws(() => parseCliArguments(args), undefined, JSON.stringify(args));
  }
});

test('local operator identity publishes atomically and survives concurrent invocations', async t => {
  const root = await directory(t);
  const ids = await Promise.all(Array.from({ length: 8 }, () => readCliOperator(root)));
  assert.equal(new Set(ids).size, 1);
  const value = JSON.parse(await readFile(join(root, 'hongguo-cli-operator.json'), 'utf8'));
  assert.equal(value.version, 1); assert.equal(value.id, ids[0]);
  assert.deepEqual(await readdir(root), ['hongguo-cli-operator.json']);
  assert.equal(await readCliOperator(root), ids[0]);
});

test('corrupt or linked operator records are preserved instead of silently replaced', async t => {
  const root = await directory(t), record = join(root, 'hongguo-cli-operator.json');
  await writeFile(record, '{invalid');
  await assert.rejects(readCliOperator(root), { code: 'invalid_cli_identity' });
  assert.equal(await readFile(record, 'utf8'), '{invalid');
  await rm(record);
  const other = join(root, 'other'); await writeFile(other, '{untouched');
  await symlink(other, record);
  await assert.rejects(readCliOperator(root), { code: 'invalid_cli_identity' });
  assert.equal(await readFile(other, 'utf8'), '{untouched');
});

test('download and resume pass the original caller and wait result through the shared library', async () => {
  const calls = [], expected = { ok: true, complete: false, requestedQuality: '720p' };
  const tasks = { async download(args, identity, exec) { calls.push({ args, identity, exec }); return expected; },
    async control(args, identity, active) { calls.push({ args, identity, active }); return expected; } };
  const active = signal(), progress = () => {};
  assert.equal(await executeCliCommand(parseCliArguments(['download', '-s', '1', '-q', '720p']), {}, tasks, caller, active, progress), expected);
  assert.equal(calls[0].identity, caller); assert.equal(calls[0].exec.signal, active); assert.equal(calls[0].exec.onProgress, progress);
  assert.equal(await executeCliCommand(parseCliArguments(['resume', taskId]), {}, tasks, caller, active), expected);
  assert.deepEqual(calls[1].args, { action: 'resume', taskId }); assert.equal(calls[1].identity, caller);
});

test('cancel snapshots the exact run and preserves a pending acknowledgement', async () => {
  const calls = [], pending = { ok: true, control: { state: 'pending', runId, requestId: 'stop-1' } };
  const tasks = { async control(args) { calls.push(args); return args.action === 'status' ? { ok: true, task: { runId } } : pending; } };
  const result = await executeCliCommand(parseCliArguments(['cancel', taskId, '--request-id', 'stop-1']), {}, tasks, caller, signal());
  assert.equal(result, pending);
  assert.deepEqual(calls, [{ action: 'status', taskId }, { action: 'cancel', taskId, expectedRunId: runId, requestId: 'stop-1' }]);
});

test('an explicit run does not select a newer run and failed status sends no control', async () => {
  const calls = [], tasks = { async control(args) { calls.push(args); return { ok: false, code: 'wrong_owner' }; } };
  await executeCliCommand(parseCliArguments(['pause', taskId, '--run-id', oldRunId, '--request-id', 'stop']), {}, tasks, caller, signal());
  assert.deepEqual(calls, [{ action: 'pause', taskId, expectedRunId: oldRunId, requestId: 'stop' }]);
  calls.length = 0;
  const result = await executeCliCommand(parseCliArguments(['cancel', taskId]), {}, tasks, caller, signal());
  assert.equal(result.code, 'wrong_owner'); assert.deepEqual(calls, [{ action: 'status', taskId }]);
});

test('CLI refuses a context that was not launched by a dsh profile', () => {
  assert.throws(() => apply({ get: () => undefined }), /dsh profile launcher/);
});

test('merge parses one source task and leaves omitted episode selection to its recorded request', () => {
  const request = parseCliArguments(['merge', taskId, '--series', '10001', '--episodes', '3,1', '--mode', 'compatible', '--output', 'combined0.mp4']);
  assert.deepEqual(request.merge, { taskId, seriesId: '10001', episodes: [3, 1], mode: 'compatible', outputFile: 'combined0.mp4' });
  const originalSelection = parseCliArguments(['merge', taskId]);
  assert.deepEqual(originalSelection.merge, { taskId });
  assert.equal(Object.hasOwn(originalSelection.merge, 'episodes'), false);
  assert.equal(originalSelection.permissionMode, 'workspace-write');
});

test('merge rejects foreign paths, several series and options from download', () => {
  for (const extra of [['--output', '../combined.mp4'], ['--output', '/tmp/combined.mp4'], ['--output', 'C:\\combined.mp4'],
    ['--output', '.mp4'], ['--output', 'combined'], ['--series', '1', '--series', '2'], ['--mode', 'fast'],
    ['--quality', '720p'], ['--source-mode', 'legacy']]) {
    assert.throws(() => parseCliArguments(['merge', taskId, ...extra]), undefined, JSON.stringify(extra));
  }
  assert.throws(() => parseCliArguments(['download', '--series', '1', '--mode', 'copy']));
});

test('merge delegates to its owner once without issuing downloads or replacing the original caller', async () => {
  const calls = [], expected = { ok: true, path: '/checkpoint/combined.mp4', modeUsed: 'compatible' }, active = signal();
  const request = parseCliArguments(['merge', taskId, '--series', '10001', '--mode', 'auto', '--output', 'combined.mp4']);
  const merger = { async merge(args, identity, receivedSignal) { calls.push(['merge', args, identity, receivedSignal]); return expected; } };
  const forbidden = { download() { throw new Error('merge must not download'); }, control() { throw new Error('merge must not start a download run'); } };
  const result = await executeCliCommand(request, {}, forbidden, caller, active, value => { calls.push(['progress', value]); }, merger);
  assert.equal(result, expected); assert.equal(calls.length, 2);
  assert.equal(calls[0][1].phase, 'started');
  assert.deepEqual(calls[1], ['merge', request.merge, caller, active]);
});

test('a missing-episode merge failure is returned without retry or a source download', async () => {
  let calls = 0;
  const expected = { ok: false, code: 'missing_episode', message: 'requested episode is missing' };
  const result = await executeCliCommand(parseCliArguments(['merge', taskId, '--episodes', '1,2']), {}, {}, caller, signal(), undefined,
    { async merge() { calls++; return expected; } });
  assert.equal(result, expected); assert.equal(calls, 1);
});
