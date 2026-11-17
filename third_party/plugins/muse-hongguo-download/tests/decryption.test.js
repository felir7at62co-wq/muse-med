/** Real CENC media and controlled worker observations cover private keys and joined cancellation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecryptor } from '../src/decryption.js';
import { resolveConfig } from '../src/config.js';
import { validateMp4 } from '../src/media.js';

const ffmpeg = process.env.MUSE_HONGGUO_TEST_FFMPEG ?? 'ffmpeg';
const signal = () => new AbortController().signal;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function paths(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-cenc-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.mp4'), 'owned source');
  return { root, inputPath: join(root, 'source.mp4'), outputPath: join(root, 'clear.mp4'), contentKey: 'a'.repeat(32), signal: signal() };
}

test('generic subsample CENC cannot be treated as fully decoded by the ByteVC2 worker', async t => {
  if (spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status !== 0) { t.skip('requires a local FFmpeg test tool'); return; }
  const local = await paths(t);
  const encode = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=1', '-an',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', local.contentKey,
    '-encryption_kid', 'b'.repeat(32), local.inputPath], { encoding: 'utf8' });
  assert.equal(encode.status, 0, encode.stderr);
  const original = await readFile(local.inputPath);
  assert.equal(original.includes(Buffer.from('senc')), true, 'FFmpeg must produce an actual CENC fixture');
  const decrypt = createDecryptor(resolveConfig());
  await assert.rejects(decrypt(local), { code: 'decryption_failed' });
  await assert.rejects(readFile(local.outputPath), { code: 'ENOENT' });
  assert.deepEqual(await readFile(local.inputPath), original);
  const oversized = join(local.root, 'oversized.mp4');
  await writeFile(oversized, Buffer.alloc(2048));
  await assert.rejects(createDecryptor(resolveConfig({ maxDecryptionBytes: 1024 }))({ ...local, inputPath: oversized, outputPath: join(local.root, 'too-large.mp4') }), { code: 'decryption_size' });
});

function controlled(termination) {
  const worker = new EventEmitter();
  worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
  worker.terminate = () => termination.promise;
  let calls = 0, started;
  const ready = deferred();
  const decrypt = createDecryptor(resolveConfig(), { createWorker(path, options) { calls++; started = { path, options }; ready.resolve(); return worker; } });
  return { worker, decrypt, ready, get calls() { return calls; }, get started() { return started; } };
}

test('worker cancellation waits for termination and queued work never starts', async t => {
  const local = await paths(t), term = deferred(), f = controlled(term), runningController = new AbortController();
  const running = f.decrypt({ ...local, signal: runningController.signal });
  await f.ready.promise;
  const queuedController = new AbortController();
  const queued = f.decrypt({ ...local, outputPath: join(local.root, 'queued.mp4'), signal: queuedController.signal });
  queuedController.abort();
  await assert.rejects(queued);
  runningController.abort();
  let finished = false; void running.catch(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  term.resolve(1);
  await assert.rejects(running);
  assert.equal(f.calls, 1);
  assert.equal(f.started.options.workerData.contentKey, local.contentKey);
  assert.equal(JSON.stringify(f.started.path).includes(local.contentKey), false);
});

test('unconfirmed worker termination quarantines the queue and preserves its private output', async t => {
  const local = await paths(t), term = deferred(), f = controlled(term);
  const work = f.decrypt(local);
  await f.ready.promise;
  await writeFile(local.outputPath, 'writer may still be running');
  f.worker.emit('message', { ok: true });
  term.reject(new Error('PRIVATE_TERMINATION_DIAGNOSTIC'));
  await assert.rejects(work, error => error.code === 'cleanup_unconfirmed' && !error.message.includes('PRIVATE'));
  await assert.rejects(f.decrypt(local), { code: 'cleanup_unconfirmed' });
  assert.equal(f.calls, 1);
  assert.equal(await readFile(local.outputPath, 'utf8'), 'writer may still be running');
});


const box = (type, bytes) => { const h = Buffer.alloc(8); h.writeUInt32BE(bytes.length + 8); h.write(type, 4); return Buffer.concat([h, bytes]); };
function fullSampleCenc(key) {
  const plain = Buffer.from('an owned full-sample payload for the AES-CTR decryption oracle');
  const iv = Buffer.from('0102030405060708', 'hex');
  const encrypted = createCipheriv('aes-128-ctr', Buffer.from(key, 'hex'), Buffer.concat([iv, Buffer.alloc(8)])).update(plain);
  const table = (values) => { const data = Buffer.alloc(values.length * 4); values.forEach((n, i) => data.writeUInt32BE(n, i * 4)); return data; };
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom'));
  const moov = offset => box('moov', box('trak', box('mdia', box('minf', box('stbl', Buffer.concat([
    box('stsd', Buffer.concat([table([0, 1]), box('encv', Buffer.concat([Buffer.alloc(78), box('avcC', Buffer.from([1, 2, 3, 4])),
      box('sinf', box('frma', Buffer.from('avc1')))]))])),
    box('stsz', table([0, plain.length, 1])), box('stco', table([0, 1, offset])), box('stsc', table([0, 1, 1, 1, 1])),
    box('senc', Buffer.concat([table([0, 1]), iv])),
  ]))))));
  const bytes = Buffer.concat([ftyp, moov(ftyp.length + moov(0).length + 8), box('mdat', encrypted)]);
  return { bytes, plain, encrypted };
}

test('8-byte-IV full-sample worker decrypts through the pinned engine and preserves its input', async t => {
  const local = await paths(t), fixture = fullSampleCenc(local.contentKey);
  await writeFile(local.inputPath, fixture.bytes);
  const decrypt = createDecryptor(resolveConfig());
  await decrypt(local);
  await validateMp4(local.outputPath);
  const result = await readFile(local.outputPath);
  assert.equal(result.includes(fixture.plain), true);
  assert.equal(result.includes(fixture.encrypted), false);
  assert.equal(result.includes(Buffer.from('encv')), false);
  assert.deepEqual(await readFile(local.inputPath), fixture.bytes);
  await assert.rejects(decrypt(local), { code: 'decryption_failed' });
  assert.deepEqual(await readFile(local.outputPath), result);
});
