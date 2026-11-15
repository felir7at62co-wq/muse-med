/** Fake managed peers verify v2 ownership without loading original runtime code or using a network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { V2Session } from '../src/v2-session.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const detail = { id: '7687998333729639449', title: '示例剧', episodes: [{ number: 1, durationSec: 93 }, { number: 2, durationSec: 90 }] };
const safe = code => error => error.code === code && !error.message.includes('PRIVATE') && error.cause === undefined;

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hongguo-v2-session-')));
  const peers = [];
  let session;
  t.after(async () => {
    try {
      for (const peer of peers) peer.finish();
      if (session) {
        try { await session.dispose(); } catch (error) { assert.ok(options.terminationFailure); }
      }
      for (const peer of peers) assert.equal(peer.finished, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const runtime = join(root, 'runtime'), state = join(root, 'state'), runDir = join(root, 'run'), outputDir = join(runDir, 'output');
  await mkdir(runtime); await mkdir(state, { mode: 0o700 });
  const files = [];
  for (const path of ['host.jar', 'broker/MuseHongguoLicenseBroker.dll', 'engine/a.jar', 'signer/classes.jar', 'jna/native.bin']) {
    const absolute = join(runtime, path), bytes = Buffer.from('fixture:' + path);
    await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, bytes);
    files.push({ path, bytes: bytes.length, sha256: sha(bytes) });
  }
  const executables = [];
  for (const name of ['java', 'dotnet', 'ffmpeg']) {
    const path = join(root, name), bytes = Buffer.from('fixture executable ' + name);
    await writeFile(path, bytes); executables.push({ name, path, bytes: bytes.length, sha256: sha(bytes) });
  }
  const manifest = { version: 1, engineVersion: 'hongguo-helper-0.3.14', build: 15,
    javaExecutable: executables[0].path, dotnetExecutable: executables[1].path,
    hostJar: 'host.jar', brokerDll: 'broker/MuseHongguoLicenseBroker.dll', engineLibDir: 'engine', signerDir: 'signer', jnaDir: 'jna',
    requiresRosetta: false, files, executables };
  const manifestBytes = JSON.stringify(manifest) + '\n';
  await writeFile(join(runtime, 'v2-runtime.json'), manifestBytes);
  await writeFile(join(state, 'device.json'), JSON.stringify({ version: 1, platform: process.platform,
    deviceId: 'd1:00000000000000000000000000000000' }), { mode: 0o600 });
  const config = { v2RuntimeDir: runtime, v2StateDir: state, maxResponseBytes: 1024 * 1024,
    v2StartupTimeoutMs: 5000, v2RequestTimeoutMs: 1000, v2ShutdownTimeoutMs: 1000,
    v2MaxLineBytes: 65536, v2MaxPendingRequests: 8, mediaProcessGraceMs: 100,
    v2EpisodesAtOnce: 1, v2ConnectionsPerFile: 1, v2MaxEpisodesPerJob: 10000,
    v2Quality: '720p', ffmpegExecutable: join(root, 'ffmpeg'), callTimeoutMs: 60000, v2PollIntervalMs: 100 };
  const calls = [], waiters = [], callbackGate = deferred();
  const f = { root, runtime, state, runDir, outputDir, manifest, manifestBytes, config, calls, peers,
    next(method) {
      const existing = calls.find(call => call.method === method);
      if (existing) return Promise.resolve(existing);
      const value = deferred(); waiters.push({ method, ...value }); return value.promise;
    } };
  const subprocess = { spawn(spec) {
    const broker = spec.argv.includes('--config'), label = broker ? 'broker' : 'engine';
    const stdout = new PassThrough(), stderr = new PassThrough(), done = deferred();
    let finished = false;
    const peer = { label, spec, stdout, stderr, done, terminateCount: 0, finished: false,
      send(message) { stdout.write(JSON.stringify(message) + '\n'); },
      finish() { if (finished) return; finished = true; peer.finished = true; stdout.end(); stderr.end(); done.resolve({ exitCode: 0, signal: null }); } };
    async function dispatch(message) {
      const call = { peer: label, ...message }; calls.push(call);
      for (const waiter of waiters) if (waiter.method === message.method) waiter.resolve(call);
      let result;
      if (message.method === '$/cancelRequest') return;
      if (message.method === 'app.hello') result = { engineVersion: broker ? 'muse-hongguo-license-broker-1' : manifest.engineVersion,
        protocol: 2, build: broker ? 1 : manifest.build, capabilities: [] };
      else if (message.method === 'app.shutdown') {
        peer.send({ jsonrpc: '2.0', id: message.id, result: {} }); peer.finish(); return;
      } else if (message.method === 'series.detail') result = options.catalogs?.[message.params.id] ?? options.detail ?? detail;
      else if (message.method === 'local_status') {
        if (options.holdLocalStatus) return;
        result = Object.hasOwn(options, 'localStatus') ? options.localStatus : {
          mode: 'Checking', reason: 'checking', licensed: false, hasKey: false, pcOnly: false,
          privateToken: 'PRIVATE_LOCAL_TOKEN', deviceId: 'd1:00000000000000000000000000000000',
        };
      }
      else if (message.method === 'refresh') {
        if (options.holdRefresh) return;
        result = { mode: 'Unlicensed', licensed: false, hasKey: false, pcOnly: false, reason: 'no_key' };
      } else if (message.method === 'license.status') result = { state: options.licensedHelper ? 'licensed' : 'none' };
      else if (message.method === 'license.set' || message.method === 'downloads.cancelAll') result = {};
      else if (message.method === 'check_series') {
        if (options.refused) result = { allowed: false, reason: 'limit', freeUsed: 2, freeLimit: 2 };
        else if (options.channel) {
          peer.send({ jsonrpc: '2.0', method: 'license.channel', params: { callbackId: 'proof-fixture',
            method: 'license.challenge', params: { purpose: 'series', seriesId: detail.id } } });
          await callbackGate.promise;
          result = { allowed: true, reason: 'free', freeUsed: 1, freeLimit: 2 };
        } else result = { allowed: true, reason: 'free', freeUsed: 1, freeLimit: 2 };
      } else if (message.method === 'license.challenge') result = { nonce: 'fixture-nonce', deviceId: 'd1:00000000000000000000000000000000' };
      else if (message.method === 'proof_response') { callbackGate.resolve(); result = {}; }
      else if (message.method === 'downloads.add') {
        f.requested = message.params.requests[0];
        result = { added: [f.requested.seriesId], busy: [] };
      } else if (message.method === 'downloads.snapshot') {
        const name = options.folderFor ? options.folderFor(f.requested.seriesId) : options.titleFolder ?? f.requested.title;
        const folder = join(outputDir, name);
        await mkdir(folder, { recursive: true });
        result = { jobs: [{ seriesId: f.requested.seriesId, state: options.failed ? 'failed' : 'done',
          done: f.requested.episodes.length, episodes: f.requested.episodes.length, failed: options.failed ? 1 : 0,
          ...(options.omitFolder ? {} : { folder }),
          errorText: 'PRIVATE_UPSTREAM_BODY', ...options.job }] };
      } else throw new Error('Unexpected fixture method: ' + message.method);
      if (!finished) peer.send({ jsonrpc: '2.0', id: message.id, result });
    }
    const stdin = new Writable({ write(bytes, _encoding, callback) {
      callback();
      void dispatch(JSON.parse(bytes.toString('utf8'))).catch(error => { stderr.write(String(error)); peer.finish(); });
    } });
    peers.push(peer);
    queueMicrotask(() => peer.send({ jsonrpc: '2.0', method: 'engine.ready', params: {
      engineVersion: broker ? 'muse-hongguo-license-broker-1' : manifest.engineVersion, protocol: 2 } }));
    return { stdin, stdout, stderr, done: done.promise,
      terminate() {
        peer.terminateCount++;
        if (options.terminationFailure) throw new Error('PRIVATE_TERMINATION');
        peer.finish();
      },
      waitForExit() { return done.promise.then(() => true); } };
  } };
  f.session = new V2Session(subprocess, config, { runDir, outputDir }, {
    readDeviceIdentity: async () => options.physicalIdentity ?? 'd1:00000000000000000000000000000000',
  });
  session = f.session;
  return f;
}

test('start verifies actual bytes and keeps device values out of argv and environment', async t => {
  const f = await fixture(t); await f.session.start();
  assert.equal(f.session.sourceIdentity, sha(f.manifestBytes));
  assert.equal(f.peers.length, 2);
  const engine = f.peers[0].spec;
  assert.ok(engine.argv.includes(f.manifest.javaExecutable));
  assert.equal(engine.argv[engine.argv.indexOf('-cp') + 1], join(f.runtime, 'host.jar') + delimiter + join(f.runtime, 'engine', '*'));
  assert.equal(JSON.stringify(f.peers.map(peer => peer.spec)).includes('d1:'), false);
  const broker = f.peers[1].spec, brokerConfig = JSON.parse(readFileSync(broker.argv.at(-1), 'utf8'));
  assert.equal(brokerConfig.deviceFile, join(f.state, 'device.json'));
  assert.equal(brokerConfig.maxPendingRequests, f.config.v2MaxPendingRequests);
  await f.session.dispose(); assert.equal(f.session.close(), f.session.dispose());
});

test('runtime mutation is refused before spawning a process', async t => {
  const f = await fixture(t); await writeFile(join(f.runtime, 'host.jar'), 'PRIVATE_CHANGED');
  await assert.rejects(f.session.start(), safe('v2_runtime_invalid'));
  assert.equal(f.peers.length, 0);
});

test('an unlisted classpath resource is refused', async t => {
  const f = await fixture(t); await writeFile(join(f.runtime, 'engine', 'injected.jar'), 'PRIVATE');
  await assert.rejects(f.session.start(), safe('v2_runtime_invalid'));
  assert.equal(f.peers.length, 0);
});

test('a changed device platform is refused without deriving or replacing an identity', async t => {
  const f = await fixture(t), path = join(f.state, 'device.json');
  const value = JSON.stringify({ version: 1, platform: 'different', deviceId: 'd1:00000000000000000000000000000000' });
  await writeFile(path, value, { mode: 0o600 });
  await assert.rejects(f.session.start(), safe('v2_device_invalid'));
  assert.equal(await readFile(path, 'utf8'), value); assert.equal(f.peers.length, 0);
});

test('a state copied from another physical device is refused and preserved', async t => {
  const f = await fixture(t, { physicalIdentity: 'd1:11111111111111111111111111111111' });
  const path = join(f.state, 'device.json'), before = await readFile(path, 'utf8');
  await assert.rejects(f.session.start(), safe('v2_device_invalid'));
  assert.equal(await readFile(path, 'utf8'), before); assert.equal(f.peers.length, 0);
});

test('a separate FFmpeg path is accepted only when it has the verified executable bytes', async t => {
  for (const same of [true, false]) {
    const f = await fixture(t), actual = join(f.root, 'selected-ffmpeg');
    await writeFile(actual, same ? await readFile(f.config.ffmpegExecutable) : 'PRIVATE_DIFFERENT_EXECUTABLE');
    f.config.ffmpegExecutable = actual;
    if (same) { await f.session.start(); assert.equal(f.peers.length, 2); }
    else { await assert.rejects(f.session.start(), safe('v2_runtime_invalid')); assert.equal(f.peers.length, 0); }
  }
});

test('catalog uses the complete original directory without a license or media call', async t => {
  const f = await fixture(t), result = await f.session.catalog(detail.id);
  assert.deepEqual(result, { seriesId: detail.id, title: detail.title, episodeCount: 2, source: 'hongguo-v2', episodes: [
    { index: 1, vid: detail.id + ':1', title: '第 1 集', durationSeconds: 93 },
    { index: 2, vid: detail.id + ':2', title: '第 2 集', durationSeconds: 90 },
  ] });
  assert.deepEqual(f.calls.filter(call => !call.method.startsWith('app.')).map(call => call.method), ['series.detail']);
});

test('health reads only unrefreshed local status and returns whitelisted handshake facts', async t => {
  const f = await fixture(t), result = await f.session.health();
  assert.deepEqual(result, { sourceIdentity: sha(f.manifestBytes),
    engine: { engineVersion: f.manifest.engineVersion, protocol: 2, build: 15 },
    localLicenseStatus: { mode: 'Checking', reason: 'checking', refreshed: false } });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(result).includes('d1:'), false);
  await f.session.dispose();
  assert.deepEqual(f.calls.filter(call => !call.method.startsWith('app.')).map(call => call.method), ['local_status']);
  assert.ok(f.peers.every(peer => peer.finished));
});

test('health accepts each real SDK mode without interpreting it as refreshed authorization', async t => {
  for (const mode of ['Checking', 'Licensed', 'Grace', 'Unlicensed']) {
    const f = await fixture(t, { localStatus: { mode, reason: 'cached', PRIVATE: 'not-returned' } });
    const result = await f.session.health();
    assert.deepEqual(result.localLicenseStatus, { mode, reason: 'cached', refreshed: false });
    assert.deepEqual(f.calls.filter(call => !call.method.startsWith('app.')).map(call => call.method), ['local_status']);
  }
});

test('health rejects unknown SDK modes and unsafe status text without exposing it', async t => {
  for (const localStatus of [null, { mode: 'licensed', reason: 'checking' }, { mode: 'PRIVATE_UNKNOWN', reason: 'checking' },
    { mode: 'Checking', reason: 'https://PRIVATE/token' }, { mode: 'Checking', reason: 'x'.repeat(65) }, { mode: 'Checking', reason: '' }]) {
    const f = await fixture(t, { localStatus });
    await assert.rejects(f.session.health(), safe('v2_protocol'));
    assert.deepEqual(f.calls.filter(call => !call.method.startsWith('app.')).map(call => call.method), ['local_status']);
  }
});

test('cancelling a pending local health read joins peers without a licensing or media call', async t => {
  const f = await fixture(t, { holdLocalStatus: true }), controller = new AbortController();
  const work = f.session.health(controller.signal), rejected = assert.rejects(work, safe('v2_cancelled'));
  await f.next('local_status'); controller.abort(new Error('PRIVATE_CANCEL'));
  await rejected;
  assert.ok(f.peers.every(peer => peer.finished));
  assert.equal(f.calls.some(call => /^(?:refresh|check_series|license\.|downloads\.|playback\.)/.test(call.method)), false);
});

test('mismatched IDs and episode gaps cannot become a complete catalog', async t => {
  for (const changed of [{ ...detail, id: 'other' }, { ...detail, episodes: [{ number: 2 }] }, { ...detail, episodes: [] }]) {
    const f = await fixture(t, { detail: changed });
    await assert.rejects(f.session.catalog(detail.id), safe('v2_catalog_invalid'));
  }
});

test('download mirrors original free initialization and acknowledges a proof callback while its request is pending', async t => {
  const f = await fixture(t, { channel: true });
  const result = await f.session.download(detail.id, detail.title, [1], '720p');
  assert.deepEqual(result, { job: { state: 'done', done: 1, episodes: 1, failed: 0, errorCode: null }, folder: join(f.outputDir, detail.title) });
  const methods = f.calls.filter(call => !call.method.startsWith('app.')).map(call => call.method);
  assert.deepEqual(methods, ['refresh', 'license.status', 'license.set', 'check_series', 'license.challenge', 'proof_response', 'downloads.add', 'downloads.snapshot']);
  assert.deepEqual(f.calls.find(call => call.method === 'license.set').params, { mode: 'free' });
});

test('a helper already licensed is preserved during normal startup synchronization', async t => {
  const f = await fixture(t, { licensedHelper: true });
  await f.session.download(detail.id, detail.title, [1], '720p');
  assert.equal(f.calls.some(call => call.method === 'license.set'), false);
  assert.equal(f.calls.filter(call => call.method === 'check_series').length, 1);
});

test('license refusal stops before download submission and preserves bounded quota facts', async t => {
  const f = await fixture(t, { refused: true });
  await assert.rejects(f.session.download(detail.id, detail.title, [1], '720p'), error => safe('v2_license_refused')(error)
    && error.safeReason === 'limit' && error.freeUsed === 2 && error.freeLimit === 2);
  assert.equal(f.calls.some(call => call.method === 'downloads.add'), false);
});

test('failed terminal jobs do not expose raw source text or produce an accepted folder', async t => {
  const f = await fixture(t, { failed: true });
  await assert.rejects(f.session.download(detail.id, detail.title, [1], '720p'), safe('v2_download_failed'));
  assert.equal(f.calls.filter(call => call.method === 'downloads.add').length, 1);
});

test('terminal counts and an escaped source folder are refused', async t => {
  for (const job of [{ done: 0 }, { episodes: 2 }, { failed: 1 }, { folder: join(tmpdir(), 'PRIVATE_OUTSIDE') }]) {
    const f = await fixture(t, { job });
    await assert.rejects(f.session.download(detail.id, detail.title, [1], '720p'), error => ['v2_download_failed', 'v2_output_invalid'].includes(error.code));
  }
});

test('cancellation during a license request joins both processes before rejecting', async t => {
  const f = await fixture(t, { holdRefresh: true }), controller = new AbortController();
  const work = f.session.download(detail.id, detail.title, [1], '720p', controller.signal);
  const rejected = assert.rejects(work, safe('v2_cancelled'));
  await f.next('refresh'); controller.abort(new Error('PRIVATE_ABORT'));
  await rejected;
  assert.ok(f.peers.every(peer => peer.finished));
  assert.equal(f.calls.some(call => call.method === 'downloads.add'), false);
});

test('a second download on one session is refused while the first permission request is pending', async t => {
  const f = await fixture(t, { holdRefresh: true }), controller = new AbortController();
  const first = f.session.download(detail.id, detail.title, [1], '720p', controller.signal), rejected = assert.rejects(first, safe('v2_cancelled'));
  await f.next('refresh');
  await assert.rejects(f.session.download(detail.id, detail.title, [2], '720p'), safe('v2_busy'));
  controller.abort(); await rejected;
});

test('dispose waits for startup filesystem work held behind an explicit barrier', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), events = [];
  const setup = f.session.setup.bind(f.session);
  f.session.setup = async () => {
    entered.resolve();
    await release.promise;
    try { return await setup(); }
    finally { events.push('setup-finished'); }
  };
  const starting = f.session.start(), rejected = assert.rejects(starting, safe('v2_cancelled'));
  await entered.promise;
  const disposing = f.session.dispose().then(() => { events.push('disposed'); });
  release.resolve();
  await Promise.all([rejected, disposing]);
  assert.deepEqual(events, ['setup-finished', 'disposed']);
  assert.equal(f.peers.length, 0, 'An aborted setup must not spawn a peer');
});

test('two different series with the same title use their actual newly created source folders', async t => {
  const second = '7687998333729639450', secondFolder = detail.title + ' (' + second + ')';
  const f = await fixture(t, { folderFor: id => id === detail.id ? detail.title : secondFolder });
  const first = await f.session.download(detail.id, detail.title, [1], '720p');
  const next = await f.session.download(second, detail.title, [1], '720p');
  assert.equal(first.folder, join(f.outputDir, detail.title));
  assert.equal(next.folder, join(f.outputDir, secondFolder));
  assert.equal(f.calls.filter(call => call.method === 'check_series').length, 2);
});
