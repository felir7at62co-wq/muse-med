/** Fake v2 sessions retain the real MP4, filesystem, hashing and journal implementation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { V2DownloadClient } from '../src/v2-download.js';

const box = (type, data = Buffer.alloc(0)) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length + 8); head.write(type, 4); return Buffer.concat([head, data]); };
const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', box('trak', box('mdia'))), box('mdat', Buffer.from('fixture video'))]);
const checksum = createHash('sha256').update(mp4).digest('hex');
const identity = 'a'.repeat(64);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fileName = index => `S01E${String(index).padStart(3, '0')}.mp4`;

async function files(root) {
  try { return await readdir(root, { recursive: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function fixture(t, change = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-v2-download-test-'))), output = join(root, 'user-output');
  const config = { v2RuntimeDir: join(root, 'runtime'), v2StateDir: join(root, 'state'), v2Quality: '720p',
    maxEpisodeBytes: 1024 * 1024, maxResponseBytes: 1024 * 1024, callTimeoutMs: 10_000, ...change.config };
  const f = { root, output, sessions: [], jobs: [], processed: [], events: [], authorizationCalls: 0,
    count: 3, sourceIdentity: identity, processFailureAt: null, ...change };
  const processMedia = async (media, args) => {
    assert.deepEqual(media, { encryption: null });
    assert.equal(args.inputPath.endsWith('.part'), true);
    assert.equal(args.signal.aborted, false);
    f.processed.push(args.inputPath);
    if (f.processFailureAt === f.processed.length) throw new Error('PRIVATE_DECODER_DIAGNOSTIC');
    if (f.processAction) await f.processAction(media, args);
    return { processedPath: args.inputPath, durationSeconds: 12, fullDecodeChecked: true, validationLevel: 'ffprobe-full-decode-sha256', ...f.processResult };
  };
  const sessionFactory = async (_subprocess, actualConfig, paths) => {
    assert.equal(actualConfig, config);
    const session = { paths, disposed: false, closeTask: null,
      async start(signal) { signal.throwIfAborted(); session.sourceIdentity = f.sourceIdentity; f.events.push('start'); },
      async catalog(id, signal) {
        signal.throwIfAborted(); const count = f.counts?.[id] ?? f.count;
        const value = { seriesId: id, title: `标题${id}`, episodeCount: count, source: 'hongguo-v2',
          episodes: Array.from({ length: count }, (_, index) => ({ index: index + 1, vid: `${id}:${index + 1}`, title: `集${index + 1}`, durationSeconds: 12 })) };
        return f.catalogChange ? f.catalogChange(value) : value;
      },
      async download(id, title, episodes, quality, signal) {
        f.jobs.push({ id, title, episodes, quality }); f.authorizationCalls++; f.events.push('download');
        if (f.downloadAction) return f.downloadAction({ id, title, episodes, quality, signal, paths });
        const folder = join(paths.outputDir, `series-${id}`); await mkdir(folder, { mode: 0o700 });
        for (const index of episodes) await writeFile(join(folder, fileName(index)), f.media ?? mp4);
        const result = { folder, job: { state: 'done', done: episodes.length, episodes: episodes.length, failed: 0 } };
        if (f.outputChange) await f.outputChange(result, paths, episodes);
        return result;
      },
      dispose() {
        if (!session.closeTask) session.closeTask = (async () => {
          f.events.push('dispose-enter');
          if (f.disposeBarrier) await f.disposeBarrier.promise;
          if (f.disposeFailure) throw Object.assign(new Error('PRIVATE_DISPOSE'), { code: 'v2_shutdown' });
          session.disposed = true; f.events.push('disposed');
        })();
        return session.closeTask;
      },
    };
    f.sessions.push(session); return session;
  };
  f.client = new V2DownloadClient(config, { subprocess: {}, processMedia, sessionFactory });
  f.options = (episodes = null, seriesIds = ['101']) => ({ seriesIds, mode: 'legacy', episodes, outputDir: output });
  t.after(async () => {
    f.disposeBarrier?.resolve(); f.processBarrier?.resolve();
    if (f.disposeFailure) await assert.rejects(f.client.dispose(), error => error.code === 'v2_shutdown');
    else await f.client.dispose();
    for (const session of f.sessions) await rm(session.paths.runDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  return f;
}
async function cleanSession(f) {
  for (const session of f.sessions) {
    assert.equal(session.disposed, true);
    await assert.rejects(lstat(session.paths.runDir), { code: 'ENOENT' });
  }
}

test('preserves a file created by another writer immediately before publication', async t => {
  const f = await fixture(t), sourceDir = join(f.root, 'source'), userDir = join(f.root, 'user');
  await mkdir(sourceDir); await mkdir(userDir);
  const source = join(sourceDir, 'source.mp4'), target = join(userDir, 'S01E001.mp4');
  await writeFile(source, mp4);
  const originalRename = fs.promises.rename, originalLink = fs.promises.link;
  let injected = false;
  const race = async (from, to, action) => {
    if (to === target && !injected) { injected = true; await writeFile(target, 'user file', { flag: 'wx' }); }
    return action(from, to);
  };
  fs.promises.rename = (from, to) => race(from, to, originalRename);
  fs.promises.link = (from, to) => race(from, to, originalLink);
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.client.publishFile(source, target, { outputDir: sourceDir, runDir: f.root }, new AbortController().signal),
      error => error.code === 'output_exists');
    assert.equal(injected, true);
    assert.equal(await readFile(target, 'utf8'), 'user file');
    assert.deepEqual(await readdir(userDir), ['S01E001.mp4']);
  } finally {
    fs.promises.rename = originalRename; fs.promises.link = originalLink; syncBuiltinESMExports();
  }
});

test('fails without publishing when the output filesystem cannot create a hard link', async t => {
  const f = await fixture(t), sourceDir = join(f.root, 'source'), userDir = join(f.root, 'user');
  await mkdir(sourceDir); await mkdir(userDir);
  const source = join(sourceDir, 'source.mp4'), target = join(userDir, 'S01E001.mp4');
  await writeFile(source, mp4);
  const originalLink = fs.promises.link;
  fs.promises.link = async () => { throw Object.assign(new Error('unsupported link'), { code: 'EPERM' }); };
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.client.publishFile(source, target, { outputDir: sourceDir, runDir: f.root }, new AbortController().signal),
      error => error.code === 'EPERM');
    await assert.rejects(lstat(target), { code: 'ENOENT' });
    assert.deepEqual(await readdir(userDir), []);
  } finally { fs.promises.link = originalLink; syncBuiltinESMExports(); }
});

test('records a published episode before reporting incomplete temporary-link cleanup, then resumes without downloading it again', async t => {
  const f = await fixture(t), originalRm = fs.promises.rm;
  let injected = false;
  fs.promises.rm = async (path, options) => {
    if (String(path).endsWith('.part') && !injected) {
      injected = true;
      throw Object.assign(new Error('temporary cleanup failed'), { code: 'EACCES' });
    }
    return originalRm(path, options);
  };
  syncBuiltinESMExports();
  let first;
  try { first = await f.client.download(f.options([1])); }
  finally { fs.promises.rm = originalRm; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(first.ok, false); assert.equal(first.code, 'v2_cleanup_pending');
  assert.equal(first.retainedEpisodeCount, 1);
  const checkpoint = JSON.parse(await readFile(first.checkpoint, 'utf8'));
  const target = checkpoint.completed[0].episode.path;
  assert.deepEqual(await readFile(target), mp4);
  const pending = join(first.cleanupPendingPath, 'episode.part');
  assert.deepEqual(await readFile(pending), mp4);
  await fs.promises.rm(pending);
  await writeFile(pending, 'unrelated user file');
  const resumed = await f.client.download(f.options([1]));
  assert.equal(resumed.ok, true); assert.equal(resumed.reusedEpisodeCount, 1);
  assert.equal(f.jobs.length, 1);
  assert.deepEqual(await readFile(target), mp4);
  assert.equal(await readFile(pending, 'utf8'), 'unrelated user file');
});

test('keeps a pre-existing public partial file while publishing an episode', async t => {
  const f = await fixture(t), sourceDir = join(f.root, 'source'), userDir = join(f.root, 'user');
  await mkdir(sourceDir); await mkdir(userDir);
  const source = join(sourceDir, 'source.mp4'), target = join(userDir, 'S01E001.mp4');
  await writeFile(source, mp4); await writeFile(`${target}.part`, 'older partial');
  await f.client.publishFile(source, target, { outputDir: sourceDir, runDir: f.root }, new AbortController().signal);
  assert.deepEqual(await readFile(target), mp4);
  assert.equal(await readFile(`${target}.part`, 'utf8'), 'older partial');
});

test('catalog information neither creates user output nor claims verified media', async t => {
  const f = await fixture(t), result = await f.client.info({ seriesIds: ['101'], mode: 'legacy' });
  assert.equal(result.ok, true); assert.equal(result.sourceBackend, 'v2'); assert.equal(result.sourceIdentity, identity);
  assert.equal(result.verifiedDownload, false); assert.equal(result.items[0].completeCatalog, true);
  assert.equal(result.items[0].mediaUrlsVerified, false); assert.equal(result.items[0].fullSeriesAvailable, null);
  assert.equal(f.jobs.length, 0); assert.equal(f.processed.length, 0);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' }); await cleanSession(f);
});

test('selected episode is verified and published as partial with independent final hash', async t => {
  const f = await fixture(t), result = await f.client.download(f.options([2]));
  assert.equal(result.ok, true); assert.equal(result.complete, false); assert.equal(result.sourceBackend, 'v2');
  assert.equal(result.fullDecodeChecked, true); assert.equal(result.newlyDownloadedEpisodeCount, 1); assert.equal(result.reusedEpisodeCount, 0);
  assert.equal(result.remainingEpisodeCount, 0); assert.equal(result.items[0].downloadedEpisodeCount, 1);
  assert.deepEqual(f.jobs.map(job => job.episodes), [[2]]); assert.equal(f.jobs[0].quality, '720p');
  const episode = result.items[0].episodes[0];
  assert.equal(episode.index, 2); assert.equal(episode.sha256, checksum); assert.equal(episode.bytes, mp4.length);
  assert.equal(episode.origin, 'engine-output'); assert.equal(episode.sourceBytes, null); assert.equal(episode.sourceSha256, null); assert.equal(episode.encryptedSource, null);
  assert.deepEqual(await readFile(episode.path), mp4);
  const state = JSON.parse(await readFile(result.checkpoint, 'utf8'));
  assert.equal(state.version, 2); assert.equal(state.request.backend, 'v2'); assert.equal(state.request.sourceIdentity, identity);
  assert.equal(state.request.quality, '720p'); assert.equal(state.completed.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(result.path, 'download-manifest.json'), 'utf8')), result);
  assert.equal((await files(result.path)).some(name => name.endsWith('.part')), false);
  await cleanSession(f);
});

test('two complete series use one job each and report only actual independently verified files', async t => {
  const f = await fixture(t, { counts: { '101': 3, '102': 2 } });
  const result = await f.client.download(f.options(null, ['101', '102']));
  assert.equal(result.ok, true); assert.equal(result.complete, true); assert.equal(result.retainedEpisodeCount, 5);
  assert.equal(result.newlyDownloadedEpisodeCount, 5); assert.equal(result.validatedBytes, mp4.length * 5);
  assert.deepEqual(f.jobs.map(job => [job.id, job.episodes]), [['101', [1, 2, 3]], ['102', [1, 2]]]);
  const episodes = result.items.flatMap(item => item.episodes);
  assert.equal(new Set(episodes.map(episode => episode.path)).size, 5);
  for (const episode of episodes) assert.equal(createHash('sha256').update(await readFile(episode.path)).digest('hex'), episode.sha256);
  await cleanSession(f);
});

test('a later validation failure retains verified episodes and the next identical request resumes only missing ones', async t => {
  const f = await fixture(t, { processFailureAt: 2 });
  const first = await f.client.download(f.options());
  assert.equal(first.ok, false); assert.equal(first.retainedEpisodeCount, 1); assert.equal(first.remainingEpisodeCount, 2);
  assert.equal(JSON.parse(await readFile(first.checkpoint, 'utf8')).completed.length, 1);
  assert.equal((await files(first.path)).some(name => name.endsWith('.part') || name === 'download-manifest.json'), false);
  const original = await readFile(join(first.path, '101', fileName(1)));
  f.processFailureAt = null;
  const second = await f.client.download(f.options());
  assert.equal(second.ok, true); assert.equal(second.complete, true); assert.equal(second.reusedEpisodeCount, 1); assert.equal(second.newlyDownloadedEpisodeCount, 2);
  assert.deepEqual(f.jobs.map(job => job.episodes), [[1, 2, 3], [2, 3]]);
  assert.deepEqual(await readFile(join(first.path, '101', fileName(1))), original);
  await cleanSession(f);
});

test('runtime identity changes and legacy journals cannot satisfy v2 completion', async t => {
  const f = await fixture(t); await mkdir(f.output);
  const old = join(f.output, 'hongguo-original'); await mkdir(old);
  const legacy = '{"version":1,"request":{"mode":"legacy"},"completed":[]}\n'; await writeFile(join(old, 'resume-state.json'), legacy);
  const first = await f.client.download(f.options([1])); assert.equal(first.ok, true);
  f.sourceIdentity = 'b'.repeat(64);
  const second = await f.client.download(f.options([1])); assert.equal(second.ok, true);
  assert.notEqual(first.path, second.path); assert.equal(second.reusedEpisodeCount, 0); assert.equal(f.jobs.length, 2);
  assert.equal(await readFile(join(old, 'resume-state.json'), 'utf8'), legacy);
});

test('a changed retained file is preserved and never counted as verified', async t => {
  const f = await fixture(t), first = await f.client.download(f.options([1]));
  const path = first.items[0].episodes[0].path; await writeFile(path, 'USER_CHANGED_FILE');
  const second = await f.client.download(f.options([1]));
  assert.equal(second.ok, false); assert.equal(second.code, 'output_exists'); assert.equal(second.retainedEpisodeCount, 0);
  assert.equal(await readFile(path, 'utf8'), 'USER_CHANGED_FILE');
});

test('a forged v1 journal placed at the v2 path is rejected without rewriting it', async t => {
  const f = await fixture(t), first = await f.client.download(f.options([1]));
  const state = JSON.parse(await readFile(first.checkpoint, 'utf8')); state.version = 1;
  const text = JSON.stringify(state); await writeFile(first.checkpoint, text);
  const second = await f.client.download(f.options([1]));
  assert.equal(second.ok, false); assert.equal(second.code, 'v2_checkpoint_invalid');
  assert.equal(await readFile(first.checkpoint, 'utf8'), text); assert.equal(f.jobs.length, 1);
});

test('cached records cannot inject private extra fields into new manifests', async t => {
  const f = await fixture(t), first = await f.client.download(f.options([1]));
  const state = JSON.parse(await readFile(first.checkpoint, 'utf8'));
  state.completed[0].private = 'PRIVATE_KEY'; state.completed[0].episode.url = 'https://private.invalid/secret';
  await writeFile(first.checkpoint, JSON.stringify(state));
  const second = await f.client.download(f.options([1]));
  assert.equal(second.ok, true); assert.equal(second.reusedEpisodeCount, 1);
  assert.doesNotMatch(JSON.stringify(second), /PRIVATE|https:/);
  assert.doesNotMatch(await readFile(second.checkpoint, 'utf8'), /PRIVATE|https:/);
});

for (const [name, change] of [
  ['wrong job counts', async result => { result.job.done--; }],
  ['outside output folder', async (result, paths) => { result.folder = paths.runDir; }],
  ['symlinked media', async result => { const path = join(result.folder, fileName(1)); await rm(path); await symlink('/etc/hosts', path); }],
]) {
  test(`${name} cannot publish a success receipt`, async t => {
    const f = await fixture(t, { outputChange: change });
    const result = await f.client.download(f.options([1]));
    assert.equal(result.ok, false); assert.equal(result.retainedEpisodeCount, 0); assert.equal(f.processed.length, 0);
    assert.equal((await files(f.output)).some(name => name.endsWith('.part') || name.endsWith('download-manifest.json')), false);
    await cleanSession(f);
  });
}

test('non-MP4 and oversized output fail before codec validation', async t => {
  for (const media of [Buffer.from('<html>not media</html>'), Buffer.alloc(2048)]) {
    const f = await fixture(t, { media, config: { maxEpisodeBytes: 1024 } });
    const result = await f.client.download(f.options([1]));
    assert.equal(result.ok, false); assert.equal(result.retainedEpisodeCount, 0); assert.equal(f.processed.length, 0);
    assert.equal((await files(f.output)).some(name => name.endsWith('.part')), false);
  }
});

test('false codec success cannot publish an unverified file', async t => {
  for (const processResult of [{ fullDecodeChecked: false }, { processedPath: '/outside.mp4' }, { durationSeconds: 0 }]) {
    const f = await fixture(t, { processResult });
    const result = await f.client.download(f.options([1]));
    assert.equal(result.ok, false); assert.equal(result.code, 'invalid_media');
    assert.equal((await files(f.output)).some(name => name.endsWith('.mp4') || name.endsWith('.part')), false);
  }
});

test('license refusal is terminal, safe and does not become an empty media result', async t => {
  const f = await fixture(t, { downloadAction() { throw Object.assign(new Error('PRIVATE_SERVER_RESPONSE'),
    { code: 'v2_license_refused', safeReason: 'free_limit', freeUsed: 5, freeLimit: 5 }); } });
  const result = await f.client.download(f.options());
  assert.equal(result.ok, false); assert.equal(result.code, 'v2_license_refused'); assert.equal(result.safeReason, 'free_limit');
  assert.equal(result.freeUsed, 5); assert.equal(result.freeLimit, 5); assert.equal(f.jobs.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/); await cleanSession(f);
});

test('cancelled job is disposed before private output is removed', async t => {
  const entered = deferred(), controller = new AbortController();
  const f = await fixture(t, { downloadAction: async ({ signal }) => {
    entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw Object.assign(new Error('PRIVATE_ABORT'), { code: 'v2_cancelled' });
  } });
  const work = f.client.download(f.options(), controller.signal); await entered.promise; controller.abort();
  const result = await work; assert.equal(result.ok, false); assert.equal(result.code, 'cancelled');
  assert.equal(result.retainedEpisodeCount, 0); await cleanSession(f);
});

test('success is not published until session disposal confirms shutdown', async t => {
  const barrier = deferred(), f = await fixture(t, { disposeBarrier: barrier });
  const work = f.client.download(f.options([1]));
  while (!f.events.includes('dispose-enter')) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await files(f.output)).some(name => name.endsWith('download-manifest.json')), false);
  assert.equal((await lstat(f.sessions[0].paths.runDir)).isDirectory(), true);
  barrier.resolve(); const result = await work; assert.equal(result.ok, true); await cleanSession(f);
});

test('unconfirmed shutdown preserves private staging and verified files without publishing success', async t => {
  const f = await fixture(t, { disposeFailure: true }), result = await f.client.download(f.options([1]));
  assert.equal(result.ok, false); assert.equal(result.code, 'v2_shutdown'); assert.equal(result.retainedEpisodeCount, 1);
  assert.equal((await lstat(f.sessions[0].paths.runDir)).isDirectory(), true);
  assert.equal((await files(f.output)).some(name => name.endsWith('download-manifest.json')), false);
  assert.equal((await files(f.output)).filter(name => name.endsWith('.mp4')).length, 1);
  const disposing = f.client.dispose(); assert.equal(f.client.dispose(), disposing);
  await assert.rejects(disposing, error => error.code === 'v2_shutdown' && !error.message.includes('PRIVATE'));
});

test('cancellation after decoded validation removes only the unpublished part', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { processAction() { controller.abort(new Error('PRIVATE_CANCEL_AFTER_DECODE')); } });
  const first = await f.client.download(f.options([1]), controller.signal);
  assert.equal(first.ok, false); assert.equal(first.code, 'cancelled'); assert.equal(first.retainedEpisodeCount, 0);
  assert.equal((await files(f.output)).some(name => name.endsWith('.part') || name.endsWith('.mp4')), false);
  assert.equal(JSON.parse(await readFile(first.checkpoint, 'utf8')).completed.length, 0);
  f.processAction = null;
  const second = await f.client.download(f.options([1]));
  assert.equal(second.ok, true); assert.equal(second.newlyDownloadedEpisodeCount, 1);
});

test('cancellation after atomic publication commits its verified journal before reporting cancellation', async t => {
  const controller = new AbortController(), f = await fixture(t);
  const publishFile = f.client.publishFile.bind(f.client);
  f.client.publishFile = async (...args) => {
    const facts = await publishFile(...args);
    controller.abort(new Error('PRIVATE_CANCEL_AFTER_RENAME'));
    return facts;
  };
  const first = await f.client.download(f.options([1]), controller.signal);
  assert.equal(first.ok, false); assert.equal(first.code, 'cancelled'); assert.equal(first.retainedEpisodeCount, 1);
  const state = JSON.parse(await readFile(first.checkpoint, 'utf8'));
  assert.equal(state.completed.length, 1);
  assert.equal(createHash('sha256').update(await readFile(state.completed[0].episode.path)).digest('hex'), state.completed[0].episode.sha256);
  assert.equal((await files(first.path)).some(name => name.endsWith('.part') || name.endsWith('download-manifest.json')), false);
  f.client.publishFile = publishFile;
  const second = await f.client.download(f.options([1]));
  assert.equal(second.ok, true); assert.equal(second.reusedEpisodeCount, 1); assert.equal(second.newlyDownloadedEpisodeCount, 0);
  assert.equal(f.jobs.length, 1); await cleanSession(f);
});

test('codec validation cannot certify bytes that changed during its operation', async t => {
  const changed = Buffer.from(mp4); changed[changed.length - 1] ^= 1;
  const f = await fixture(t, { processAction: async (_media, { inputPath }) => { await writeFile(inputPath, changed); } });
  const result = await f.client.download(f.options([1]));
  assert.equal(result.ok, false); assert.equal(result.code, 'invalid_media'); assert.equal(result.retainedEpisodeCount, 0);
  assert.equal((await files(f.output)).some(name => name.endsWith('.part') || name.endsWith('.mp4')), false);
});

test('concurrent identical calls cannot submit duplicate series jobs', async t => {
  const entered = deferred(), barrier = deferred();
  const f = await fixture(t, { processBarrier: barrier, processAction: async () => { entered.resolve(); await barrier.promise; } });
  const first = f.client.download(f.options([1])); await entered.promise;
  const second = await f.client.download(f.options([1]));
  assert.equal(second.ok, false); assert.equal(second.code, 'download_in_progress'); assert.equal(f.jobs.length, 1);
  barrier.resolve(); assert.equal((await first).ok, true); await cleanSession(f);
});

test('complete local reuse neither submits another job nor consumes another authorization', async t => {
  const f = await fixture(t, { count: 1 }), first = await f.client.download(f.options());
  assert.equal(first.ok, true); assert.equal(first.complete, true);
  const beforeJobs = f.jobs.length, beforeAuthorization = f.authorizationCalls;
  const second = await f.client.download(f.options());
  assert.equal(second.ok, true); assert.equal(second.complete, true); assert.equal(second.reusedEpisodeCount, 1);
  assert.equal(second.newlyDownloadedEpisodeCount, 0); assert.equal(f.jobs.length - beforeJobs, 0);
  assert.equal(f.authorizationCalls - beforeAuthorization, 0); assert.match(second.note, /本地复用文件不代表当前取流授权仍有效/);
});
