import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { ensureDeviceFile, extractLockedMembers, nativeRuntimeTarget, physicalDeviceId, SOURCE_FILES, SETUP_SHA256, withFreshOutput } from '../scripts/prepare-v2.mjs';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'hongguo-v2-preparation-')));
  roots.push(path);
  return path;
}
const digest = value => createHash('sha256').update(value).digest('hex');
let python;
for (const name of ['python3', 'python']) {
  const result = spawnSync(name, ['-I', '-B', '-c', 'import sys;assert sys.version_info>=(3,9);print(sys.executable)'], { encoding: 'utf8' });
  if (result.status === 0) { python = await realpath(result.stdout.trim()); break; }
}
async function archive(path, entries) {
  const script = 'import json,sys,zipfile,stat\ns=json.load(sys.stdin)\nwith zipfile.ZipFile(s["path"],"w") as z:\n for e in s["entries"]:\n  i=zipfile.ZipInfo(e["name"]);i.create_system=3;i.external_attr=((stat.S_IFLNK|0o777) if e.get("link") else (stat.S_IFREG|0o600))<<16;z.writestr(i,e.get("text",""))\n';
  const result = spawnSync(python, ['-I', '-B', '-c', script], { input: JSON.stringify({ path, entries }), encoding: 'utf8' });
  assert.equal(result.status, 0);
}
const selected = text => [{ member: 'sdk/selected.bin', path: 'sdk/selected.bin', bytes: Buffer.byteLength(text), sha256: digest(text) }];

test('the locked original SDK excludes saved identities and includes all required code members', () => {
  assert.equal(SETUP_SHA256, '36bd3ffc0d10f7b08401d3ccec29d2120d4cd1c693a46a20f403b085f315a5bb');
  assert.equal(SOURCE_FILES.filter(file => file.path.startsWith('engine/lib/')).length, 37);
  assert.equal(SOURCE_FILES.filter(file => file.path.startsWith('engine/signer/')).length, 2);
  assert.equal(SOURCE_FILES.filter(file => file.path.startsWith('broker/')).length, 3);
  assert.equal(new Set(SOURCE_FILES.map(file => file.member)).size, 42);
  assert.equal(SOURCE_FILES.some(file => /(?:device\.json|guest-device|queue|settings|licen[cs]e-state)/iu.test(file.member)), false);
  for (const file of SOURCE_FILES) { assert.match(file.sha256, /^[a-f0-9]{64}$/u); assert.ok(file.bytes > 0); }
});

test('physical device derivation separates Mac identities and preserves the original Windows GUID case', () => {
  const lower = '01234567-89ab-cdef-0123-456789abcdef';
  const upper = lower.toUpperCase();
  assert.equal(physicalDeviceId('darwin', lower), physicalDeviceId('darwin', upper));
  assert.equal(physicalDeviceId('win32', lower), 'd1:' + digest('mg:' + lower).slice(0, 32));
  assert.notEqual(physicalDeviceId('win32', lower), physicalDeviceId('win32', upper));
  assert.notEqual(physicalDeviceId('darwin', lower), physicalDeviceId('win32', lower));
  assert.throws(() => physicalDeviceId('linux', lower), /only local/u);
  assert.throws(() => physicalDeviceId('darwin', 'unknown'), /physical device/u);
});

test('native selection uses the Windows DLL or the matching Mac JNA resource and refuses unsupported targets', () => {
  const windows = nativeRuntimeTarget('win32', 'x64', 'x64');
  assert.equal(windows.jna.member, 'com/sun/jna/win32-x86-64/jnidispatch.dll');
  assert.equal(windows.requiresRosetta, false);
  assert.equal(nativeRuntimeTarget('darwin', 'arm64', 'x64').jna.member, 'com/sun/jna/darwin-aarch64/libjnidispatch.jnilib');
  assert.equal(nativeRuntimeTarget('darwin', 'x64', 'x64').jna.member, 'com/sun/jna/darwin-x86-64/libjnidispatch.jnilib');
  assert.equal(nativeRuntimeTarget('darwin', 'arm64', 'x64').requiresRosetta, true);
  assert.throws(() => nativeRuntimeTarget('linux', 'x64', 'x64'), /only local/u);
  assert.throws(() => nativeRuntimeTarget('win32', 'arm64', 'x64'), /Java architecture/u);
  assert.throws(() => nativeRuntimeTarget('darwin', 'arm64', 'arm64'), /x64 runtime/u);
});

test('device records persist the same host and reject a changed identity without altering licence state', async () => {
  const path = await root(), platform = process.platform === 'win32' ? 'win32' : 'darwin';
  const first = 'd1:' + '1'.repeat(32);
  const device = await ensureDeviceFile(path, platform, first);
  await writeFile(join(path, 'license-state.json'), 'preserve private licence');
  const before = await readFile(device);
  assert.equal(await ensureDeviceFile(path, platform, first), device);
  await assert.rejects(ensureDeviceFile(path, platform, 'd1:' + '2'.repeat(32)), /not replaced/u);
  assert.deepEqual(await readFile(device), before);
  assert.equal(await readFile(join(path, 'license-state.json'), 'utf8'), 'preserve private licence');
  if (process.platform !== 'win32') assert.equal((await lstat(device)).mode & 0o777, 0o600);
});

test('a malformed or over-permissive device record is refused without repair', async () => {
  const path = await root(), platform = process.platform === 'win32' ? 'win32' : 'darwin';
  const device = join(path, 'device.json');
  await writeFile(device, '{broken', { mode: 0o600 });
  await assert.rejects(ensureDeviceFile(path, platform, 'd1:' + '1'.repeat(32)), /invalid device/u);
  assert.equal(await readFile(device, 'utf8'), '{broken');
  if (process.platform !== 'win32') {
    await writeFile(device, JSON.stringify({ version: 1, platform, deviceId: 'd1:' + '1'.repeat(32) }));
    await chmod(device, 0o644);
    await assert.rejects(ensureDeviceFile(path, platform, 'd1:' + '1'.repeat(32)), /0600/u);
    assert.equal((await lstat(device)).mode & 0o777, 0o644);
  }
});

test('linked state or device paths never modify their targets', { skip: process.platform === 'win32' }, async () => {
  const path = await root(), target = join(path, 'target');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, join(path, 'linked'));
  await assert.rejects(ensureDeviceFile(join(path, 'linked'), 'darwin', 'd1:' + '1'.repeat(32)), /linked/u);
  await writeFile(join(target, 'keep'), 'private');
  await symlink(join(target, 'keep'), join(path, 'device.json'));
  await assert.rejects(ensureDeviceFile(path, 'darwin', 'd1:' + '1'.repeat(32)), /unlinked/u);
  assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'private');
});

test('an existing runtime is not entered or overwritten', async () => {
  const path = await root(), output = join(path, 'existing');
  await mkdir(output); await writeFile(join(output, 'keep'), 'existing runtime');
  let called = false;
  await assert.rejects(withFreshOutput(output, async () => { called = true; }), /exists/u);
  assert.equal(called, false);
  assert.equal(await readFile(join(output, 'keep'), 'utf8'), 'existing runtime');
});

test('failed preparation removes its stage and preserves a newly competing destination', async () => {
  const path = await root(), output = join(path, 'runtime');
  await assert.rejects(withFreshOutput(output, async stage => {
    await writeFile(join(stage, 'partial'), 'discard');
    throw new Error('compiler refused');
  }), /compiler refused/u);
  assert.deepEqual(await readdir(path), []);
  await assert.rejects(withFreshOutput(output, async stage => {
    await writeFile(join(stage, 'partial'), 'discard');
    await mkdir(output); await writeFile(join(output, 'keep'), 'another runtime');
  }), { code: 'EEXIST' });
  assert.deepEqual(await readdir(path), ['runtime']);
  assert.equal(await readFile(join(output, 'keep'), 'utf8'), 'another runtime');
});

test('a successful preparation publishes the full descriptor and removes build staging', async () => {
  const path = await root(), output = join(path, 'runtime');
  await withFreshOutput(output, async stage => {
    await mkdir(join(stage, 'nested'));
    await writeFile(join(stage, 'nested', 'file'), 'immutable');
    await writeFile(join(stage, 'v2-runtime.json'), '{"version":1}\n');
  });
  assert.equal(await readFile(join(output, 'nested', 'file'), 'utf8'), 'immutable');
  assert.equal(JSON.parse(await readFile(join(output, 'v2-runtime.json'), 'utf8')).version, 1);
  assert.deepEqual(await readdir(path), ['runtime']);
});

test('selected ZIP data is extracted with its expected hash and existing files remain untouched', { skip: !python }, async () => {
  const path = await root(), zip = join(path, 'source.zip'), output = join(path, 'output');
  await archive(zip, [{ name: 'sdk/selected.bin', text: 'locked content' }, { name: 'unselected.txt', text: 'ignored' }]);
  await extractLockedMembers(zip, output, python, selected('locked content'));
  assert.equal(await readFile(join(output, 'sdk/selected.bin'), 'utf8'), 'locked content');
  await assert.rejects(readFile(join(output, 'unselected.txt')), { code: 'ENOENT' });
  await assert.rejects(extractLockedMembers(zip, output, python, selected('locked content')), /extraction/u);
  assert.equal(await readFile(join(output, 'sdk/selected.bin'), 'utf8'), 'locked content');
});

for (const name of ['../outside', '/absolute', 'C:/windows', 'sdk\\escaped', 'sdk/../outside']) {
  test(`an unsafe unselected archive member is refused (${name})`, { skip: !python }, async () => {
    const path = await root(), zip = join(path, 'source.zip'), output = join(path, 'output');
    await archive(zip, [{ name: 'sdk/selected.bin', text: 'ok' }, { name, text: 'unsafe' }]);
    await assert.rejects(extractLockedMembers(zip, output, python, selected('ok')), /extraction/u);
    assert.deepEqual(await readdir(output), []);
    await assert.rejects(readFile(join(path, 'outside')), { code: 'ENOENT' });
  });
}

test('symlinks and case-colliding members are rejected before extracting selected bytes', { skip: !python }, async () => {
  const path = await root();
  for (const [index, extra] of [[{ name: 'linked', text: 'target', link: true }], [{ name: 'SDK/SELECTED.BIN', text: 'case collision' }]].entries()) {
    const zip = join(path, `source-${index}.zip`), output = join(path, `out-${index}`);
    await archive(zip, [{ name: 'sdk/selected.bin', text: 'ok' }, ...extra]);
    await assert.rejects(extractLockedMembers(zip, output, python, selected('ok')), /extraction/u);
    assert.deepEqual(await readdir(output), []);
  }
});

test('changed selected bytes cannot survive a hash failure', { skip: !python }, async () => {
  const path = await root(), zip = join(path, 'source.zip'), output = join(path, 'output');
  await archive(zip, [{ name: 'sdk/selected.bin', text: 'bad' }]);
  await assert.rejects(extractLockedMembers(zip, output, python, selected('old')), /extraction/u);
  await assert.rejects(readFile(join(output, 'sdk/selected.bin')), { code: 'ENOENT' });
});
