/** Private confined binary sink; its source is bundled with the importing Host module. */
export const MEDIA_FILE_HELPER = String.raw`
import { createWriteStream } from 'node:fs';
import { Socket } from 'node:net';
import { mkdir, realpath, stat, link, open, unlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const spec = JSON.parse(process.argv[1]);
const parent = join(spec.cwd, ...spec.directory.split('/'));
const staging = join(parent, '.import-' + spec.nonce);
const temporary = join(staging, 'media');
const stagedReceipt = join(staging, 'source.json');
const final = join(parent, spec.jobId + '-' + spec.name);
const receipt = final + '.source.json';
let ownsFinal = false, ownsReceipt = false, controls, controlInput;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let verificationIndex = 0;
// File-backed stdio keeps descendants confined without libuv's Windows named-pipe boundary.
async function run(program, args) {
  const prefix = join(staging, '.verify-' + ++verificationIndex);
  const paths = [prefix + '.stdout', prefix + '.stderr'];
  const handles = [];
  let timer, sampling = Promise.resolve(), outputError;
  try {
    for (const path of paths) handles.push(await open(path, 'wx+', 0o600));
    const child = spawn(program, args, { windowsHide: true, stdio: ['ignore', handles[0].fd, handles[1].fd] });
    const inspect = async () => {
      for (const handle of handles) {
        if ((await handle.stat()).size > spec.maxOutputBytes) throw Error('INVALID_MEDIA');
      }
    };
    timer = setInterval(() => {
      sampling = sampling.then(inspect).catch(error => { outputError ??= error; child.kill(); });
    }, 20);
    let spawnError;
    child.once('error', error => { spawnError = error; });
    const outcome = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    clearInterval(timer); timer = undefined;
    await sampling;
    if (spawnError) throw spawnError;
    if (outputError) throw outputError;
    await inspect();
    if (outcome.code !== 0 || outcome.signal !== null) throw Error('INVALID_MEDIA');
    const bytes = Buffer.alloc((await handles[0].stat()).size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handles[0].read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw Error('INVALID_MEDIA');
      offset += bytesRead;
    }
    return { stdout: bytes.toString('utf8') };
  } finally {
    clearInterval(timer);
    await sampling;
    await Promise.all(handles.map(handle => handle.close()));
    await Promise.all(paths.map(path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; })));
  }
}
async function cleanup() {
  if (ownsReceipt) await unlink(receipt).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (ownsFinal) await unlink(final).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await rm(staging, { recursive: true, force: true });
}
try {
  if (await realpath(spec.cwd) !== spec.cwd) throw Error('WORKSPACE_INVALID');
  let current = spec.cwd;
  for (const segment of spec.directory.split('/')) {
    current = join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (await realpath(current) !== current || !(await stat(current)).isDirectory()) {
      if (spec.operation !== 'receive') { emit({ phase: 'cleaned' }); process.exit(0); }
      throw Error('WORKSPACE_INVALID');
    }
  }
  if (spec.operation === 'finalize') {
    await rm(staging, { recursive: true, force: true }); emit({ phase: 'cleaned' });
  } else if (spec.operation === 'cleanup') {
    const identity = async path => {
      try { const info = await stat(path, { bigint: true }); return { dev: String(info.dev), ino: String(info.ino) }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
    };
    const matches = (left, right) => left && right && left.dev === right.dev && left.ino === right.ino;
    ownsFinal = matches(await identity(temporary) ?? spec.publication?.media, await identity(final));
    ownsReceipt = matches(await identity(stagedReceipt) ?? spec.publication?.receipt, await identity(receipt));
    await cleanup(); emit({ phase: 'cleaned' });
  } else {
    if (process.env.DSH_SUBPROCESS_CONTROL !== 'pipe') throw Error('NOT_COMMITTED');
    delete process.env.DSH_SUBPROCESS_CONTROL;
    controlInput = new Socket({ fd: spec.controlFd, readable: true, writable: true, allowHalfOpen: true });
    controls = createInterface({ input: controlInput, crlfDelay: Infinity });
    const instruction = (async () => { for await (const line of controls) return line; return ''; })();
    await mkdir(staging, { mode: 0o700 });
    let bytes = 0;
    const hash = createHash('sha256');
    const bound = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > spec.maxBytes || bytes > spec.bytes) callback(Error('FILE_TOO_LARGE'));
      else { hash.update(chunk); callback(null, chunk); }
    }});
    await pipeline(process.stdin, bound, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (bytes !== spec.bytes || hash.digest('hex') !== spec.sha256) throw Error('FILE_INCOMPLETE');
    const probe = await run(spec.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
      'format=format_name,duration:stream=codec_type,width,height', '-of', 'json', temporary]);
    const metadata = JSON.parse(probe.stdout);
    const video = metadata.streams?.find(stream => stream.codec_type === 'video');
    const durationSeconds = Number(metadata.format?.duration);
    const imageFormat = String(metadata.format?.format_name ?? '').split(',').some(name => name.endsWith('_pipe')
      || ['image2', 'gif', 'apng', 'ico', 'heif', 'avif'].includes(name));
    if (!video || !Number.isSafeInteger(video.width) || video.width <= 0 || !Number.isSafeInteger(video.height)
      || video.height <= 0 || video.width * video.height > spec.maxPixels
      || (spec.kind === 'video' && imageFormat)
      || (spec.kind === 'image' && !imageFormat && Number.isFinite(durationSeconds) && durationSeconds > 0)
      || (spec.kind === 'video' && (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > spec.maxDurationSeconds))) throw Error('INVALID_MEDIA');
    await run(spec.ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe', '-i', temporary,
      '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-']);
    const facts = { bytes, sha256: spec.sha256, kind: spec.kind, width: video.width, height: video.height,
      ...(spec.kind === 'video' ? { durationSeconds } : {}), fullDecodeVerified: true };
    emit({ phase: 'verified', ...facts });
    const decision = await instruction;
    controls.close(); controlInput.destroy();
    if (decision !== 'commit') throw Error('NOT_COMMITTED');
    if (await realpath(parent) !== parent || await realpath(staging) !== staging) throw Error('WORKSPACE_INVALID');
    const handle = await open(stagedReceipt, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ jobId: spec.jobId, fileName: spec.name, path: final, ...facts }) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    await link(temporary, final); ownsFinal = true;
    await link(stagedReceipt, receipt); ownsReceipt = true;
    const mediaIdentity = await stat(final, { bigint: true }), receiptIdentity = await stat(receipt, { bigint: true });
    emit({ phase: 'published', path: final, receipt, ...facts,
      publication: { media: { dev: String(mediaIdentity.dev), ino: String(mediaIdentity.ino) },
        receipt: { dev: String(receiptIdentity.dev), ino: String(receiptIdentity.ino) } } });
    // Keep the transaction link until the Host rechecks the account after publication.
  }
} catch (error) {
  try { await cleanup(); } catch (_cleanupError) { /* The Host repeats cleanup after the process range exits. */ }
  const code = error.code === 'EEXIST' ? 'LOCAL_CONFLICT' : ['FILE_TOO_LARGE', 'FILE_INCOMPLETE', 'WORKSPACE_INVALID', 'NOT_COMMITTED'].includes(error.message) ? error.message : 'INVALID_MEDIA';
  emit({ phase: 'failed', code }); process.exitCode = 1;
} finally { controls?.close(); controlInput?.destroy(); }
`
