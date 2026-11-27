import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {openMediaKitJobs} from './mediakit-jobs.mjs';
import {createMediaKitProvider} from './mediakit-provider.mjs';

const input = {operation: 'upscale', videoUrl: 'https://video.example.test/scene.mp4?temporary=fixture', resolution: '1080p'};
const approval = {operation: input.operation, resolution: input.resolution,
  sourceSha256: createHash('sha256').update(input.videoUrl).digest('hex')};

async function fixture(t, provider) {
  const directory = await mkdtemp(join(tmpdir(), 'muse-mediakit-jobs-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const options = {directory, provider, allowedSourceOrigins: ['https://video.example.test']};
  return {directory, jobs: await openMediaKitJobs(options), reopen: () => openMediaKitJobs(options)};
}

test('reopening a MediaKit submission queries its original task and keeps URLs out of receipts', async t => {
  const submits = [], queries = [];
  const {directory, jobs, reopen} = await fixture(t, {
    submit: async request => { submits.push(request); return {state: 'accepted', taskId: 'mediakit-task-1'}; },
    query: async id => { queries.push(id); return {state: 'completed', videoUrl: 'https://out.example.test/result.mp4?signature=fixture'}; },
  });
  assert.deepEqual(await jobs.submit('alice', 'clip-1', input), {state: 'accepted'});
  assert.match(submits[0].clientToken, /^[a-f0-9]{64}$/u);
  const [reservation] = await readdir(directory);
  const persisted = await readFile(join(directory, reservation, 'receipt.json'), 'utf8');
  assert.doesNotMatch(persisted, /temporary|fixture|https:|clip-1|alice/u);
  const reopened = await reopen();
  assert.deepEqual(await reopened.inspect('bob', 'clip-1'), {state: 'not_found'});
  assert.deepEqual(await reopened.submit('alice', 'clip-1', input), {state: 'accepted'});
  assert.equal(submits.length, 1);
  assert.equal((await reopened.inspect('alice', 'clip-1')).state, 'completed');
  assert.deepEqual(queries, ['mediakit-task-1']);
});

test('duplicates arriving during submission and after timeout never dispatch again', async t => {
  let submits = 0;
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const {jobs, reopen} = await fixture(t, {
    submit: async () => { submits++; entered.resolve(); await finish.promise; throw Error('Submit transport disconnected'); },
    query: async () => assert.fail('A timed-out submission has no confirmed provider task ID'),
  });
  const first = jobs.submit('alice', 'clip-1', input);
  try {
    await entered.promise;
    assert.deepEqual(await jobs.submit('alice', 'clip-1', input), {state: 'unknown', code: 'submission_unconfirmed'});
  } finally { finish.resolve(); }
  assert.equal((await first).state, 'unknown');
  const reopened = await reopen();
  assert.equal((await reopened.submit('alice', 'clip-1', input)).state, 'unknown');
  assert.equal((await reopened.inspect('alice', 'clip-1')).state, 'unknown');
  assert.equal(submits, 1);
});

test('stable rejection evidence stays distinct from a failed task with uncertain billing', async t => {
  const {jobs} = await fixture(t, {
    submit: async ({operation}) => operation === 'upscale'
      ? {state: 'rejected', code: 'invalid_parameter'}
      : {state: 'accepted', taskId: 'mediakit-erase-1'},
    query: async () => ({state: 'failed', code: 'processing_failed'}),
  });
  const rejected = {state: 'rejected', code: 'invalid_parameter'};
  assert.deepEqual(await jobs.submit('alice', 'clip-1', input), rejected);
  assert.deepEqual(await jobs.inspect('alice', 'clip-1'), rejected);
  assert.deepEqual(await jobs.submit('alice', 'clip-2', {operation: 'erase_subtitle', videoUrl: input.videoUrl}), {state: 'accepted'});
  assert.deepEqual(await jobs.inspect('alice', 'clip-2'), {state: 'failed', code: 'processing_failed'});
});

test('the shared fallback claim is bound to immutable rejection evidence and survives a service restart', async t => {
  const {directory, jobs, reopen} = await fixture(t, {
    submit: async () => ({state: 'rejected', code: 'invalid_parameter'}),
    query: async () => assert.fail('Fallback admission needs only the local rejection receipt'),
  });
  assert.equal(await jobs.claimFallback('alice', 'clip-1', approval), false);
  await jobs.submit('alice', 'clip-1', input);
  await jobs.submit('alice', 'clip-2', input);
  assert.equal(await jobs.claimFallback('bob', 'clip-1', approval), false);
  assert.equal(await jobs.claimFallback('alice', 'clip-1', {...approval, operation: 'erase_subtitle'}), false);
  assert.equal(await jobs.claimFallback('alice', 'clip-1', {...approval, resolution: '720p'}), false);
  assert.equal(await jobs.claimFallback('alice', 'clip-1', {...approval, sourceSha256: 'b'.repeat(64)}), false);
  assert.equal(await jobs.claimFallback('alice', 'clip-1', approval, {isAuthorized: () => false}), false);
  const secondWorker = await reopen();
  const granted = await Promise.all([jobs, secondWorker].map(worker => worker.claimFallback('alice', 'clip-1', approval)));
  assert.equal(granted.filter(Boolean).length, 1);
  assert.equal(await (await reopen()).claimFallback('alice', 'clip-1', approval), false);
  assert.deepEqual(await secondWorker.inspect('alice', 'clip-1'), {state: 'rejected', code: 'invalid_parameter'});

  const directoryForOldReceipt = createHash('sha256').update(JSON.stringify(['alice', 'clip-2'])).digest('hex');
  const legacyFile = join(directory, directoryForOldReceipt, 'receipt.json');
  const {approval: _absent, ...legacy} = JSON.parse(await readFile(legacyFile, 'utf8'));
  await writeFile(legacyFile, JSON.stringify(legacy));
  assert.deepEqual(await secondWorker.inspect('alice', 'clip-2'), {state: 'rejected', code: 'invalid_parameter'});
  assert.equal(await secondWorker.claimFallback('alice', 'clip-2', approval), false);
});

test('revoking authorization while recording the fallback grant consumes it without returning success', async t => {
  const {jobs, reopen} = await fixture(t, {
    submit: async () => ({state: 'rejected', code: 'invalid_parameter'}),
    query: async () => assert.fail('No paid query is needed to claim a fallback'),
  });
  await jobs.submit('alice', 'clip-1', input);
  let checks = 0;
  assert.equal(await jobs.claimFallback('alice', 'clip-1', approval, {isAuthorized: () => ++checks < 3}), false);
  assert.equal(checks, 3);
  assert.equal(await (await reopen()).claimFallback('alice', 'clip-1', approval), false);
});

test('a reserved key cannot redirect the task or bind to different input', async t => {
  let submits = 0;
  const {jobs} = await fixture(t, {
    submit: async () => { submits++; return {state: 'accepted', taskId: 'mediakit-task-1'}; },
    query: async () => ({state: 'pending'}),
  });
  await assert.rejects(jobs.submit('alice', 'clip-1', {...input, videoUrl: 'https://other.example.test/scene.mp4'}), /input origin/u);
  await assert.rejects(jobs.submit('alice', '../../invalid', input), /submission identity/u);
  await jobs.submit('alice', 'clip-1', input);
  assert.deepEqual(await jobs.submit('alice', 'clip-1', {...input, resolution: '720p'}), {state: 'conflict', code: 'idempotency_conflict'});
  assert.equal((await jobs.inspect('alice', 'clip-1')).state, 'pending');
  assert.equal(submits, 1);
});

test('dispatch retains the provider distinction between rejected and unconfirmed submissions', async t => {
  let calls = 0;
  const provider = createMediaKitProvider({apiKey: 'synthetic-key', timeoutMs: 1000,
    fetchImpl: async (_url, _options) => {
      if (++calls === 1) {
        return Response.json({code: 'RequestLimitExceeded', message: 'synthetic detail'}, {status: 429});
      }
      throw Error('No confirmation after upload');
    },
  });
  const {jobs, reopen} = await fixture(t, provider);
  assert.equal((await jobs.submit('alice', 'clip-rejected', input)).state, 'rejected');
  assert.equal((await jobs.submit('alice', 'clip-unknown', input)).state, 'unknown');
  const reopened = await reopen();
  assert.equal((await reopened.submit('alice', 'clip-rejected', input)).state, 'rejected');
  assert.equal((await reopened.submit('alice', 'clip-unknown', input)).state, 'unknown');
  assert.equal(calls, 2);
});
