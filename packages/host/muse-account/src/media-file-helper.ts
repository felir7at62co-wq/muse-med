/** Private confined binary sink; its source is bundled with the importing Host module. */
export const MEDIA_FILE_HELPER = String.raw`
import { createReadStream, createWriteStream } from 'node:fs';
import { Socket } from 'node:net';
import { mkdir, realpath, stat, lstat, link, open, unlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
    const instruction = (async () => {
      const lines = [];
      for await (const line of controls) {
        lines.push(line);
        if (lines.length > 1) throw Error('NOT_COMMITTED');
      }
      if (lines.length !== 1) throw Error('NOT_COMMITTED');
      return lines[0];
    })();
    void instruction.catch((_error) => { /* The receive branch awaits the same commit result after staging. */ });
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
    emit({ phase: 'staged' });
    const decision = JSON.parse(await instruction);
    controls.close(); controlInput.destroy();
    const verified = decision.facts;
    if (decision.action !== 'commit' || !verified || verified.bytes !== bytes || verified.sha256 !== spec.sha256
      || verified.kind !== spec.kind || verified.fullDecodeVerified !== true
      || !Number.isSafeInteger(verified.width) || verified.width <= 0
      || !Number.isSafeInteger(verified.height) || verified.height <= 0
      || verified.width * verified.height > spec.maxPixels
      || (spec.kind === 'video' && (!Number.isFinite(verified.durationSeconds)
        || verified.durationSeconds <= 0 || verified.durationSeconds > spec.maxDurationSeconds))) throw Error('NOT_COMMITTED');
    const identity = await lstat(temporary, { bigint: true });
    if (!identity.isFile() || identity.isSymbolicLink() || await realpath(temporary) !== temporary) throw Error('WORKSPACE_INVALID');
    if (!decision.media || String(identity.dev) !== decision.media.dev || String(identity.ino) !== decision.media.ino
      || String(identity.mtimeNs) !== decision.media.mtimeNs || String(identity.ctimeNs) !== decision.media.ctimeNs) throw Error('FILE_INCOMPLETE');
    const recheck = createHash('sha256');
    let checkedBytes = 0;
    for await (const chunk of createReadStream(temporary)) {
      checkedBytes += chunk.byteLength;
      if (checkedBytes > spec.bytes || checkedBytes > spec.maxBytes) throw Error('FILE_INCOMPLETE');
      recheck.update(chunk);
    }
    const checkedIdentity = await lstat(temporary, { bigint: true });
    if (checkedBytes !== spec.bytes || recheck.digest('hex') !== spec.sha256
      || checkedIdentity.dev !== identity.dev || checkedIdentity.ino !== identity.ino
      || checkedIdentity.mtimeNs !== identity.mtimeNs || checkedIdentity.ctimeNs !== identity.ctimeNs) throw Error('FILE_INCOMPLETE');
    const facts = { bytes, sha256: spec.sha256, kind: spec.kind, width: verified.width, height: verified.height,
      ...(spec.kind === 'video' ? { durationSeconds: verified.durationSeconds } : {}), fullDecodeVerified: true };
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
