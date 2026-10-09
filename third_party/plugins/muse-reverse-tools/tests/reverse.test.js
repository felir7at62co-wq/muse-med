/** Offline bounded parsing, workspace confinement, original routing and tool lifecycle checks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, writeFile, readFile, realpath, rm, stat, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectBytes, inspectFile } from '../src/inspect.js';
import { resourceRoot, resolveResourceRoot, routeTask, selectRoute } from '../src/router.js';
import { apply, resolveConfig } from '../src/index.js';

function macho() {
  const b = Buffer.alloc(82);
  b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(0x100000c, 4);
  b.writeUInt32LE(2, 12); b.writeUInt32LE(1, 16); b.writeUInt32LE(24, 20);
  b.writeUInt32LE(2, 32); b.writeUInt32LE(24, 36); b.writeUInt32LE(56, 40);
  b.writeUInt32LE(1, 44); b.writeUInt32LE(72, 48); b.writeUInt32LE(10, 52);
  b.writeUInt32LE(1, 56); b.writeBigUInt64LE(0x100001234n, 64); b.write('_sample\0', 73);
  return b;
}
const limits = { maxFileBytes: 1024, maxSymbols: 2, maxSymbolNameBytes: 128 };
const signal = () => new AbortController().signal;

test('Mach-O symbols retain exact addresses and report filtering and truncation', () => {
  assert.deepEqual(inspectBytes(macho(), limits).symbols, [{ name: '_sample', address: '0x100001234' }]);
  assert.equal(inspectBytes(macho(), limits).architecture, 'arm64');
  assert.equal(inspectBytes(macho(), { ...limits, maxSymbols: 0 }).symbolsTruncated, true);
  assert.deepEqual(inspectBytes(macho(), { ...limits, symbolContains: 'absent' }).symbols, []);
  assert.deepEqual(inspectBytes(macho(), { ...limits, maxSymbolNameBytes: 3 }).symbols[0], { name: '_sa', address: '0x100001234', nameTruncated: true });
});

test('truncated headers, commands and strings fail instead of inventing metadata', () => {
  assert.throws(() => inspectBytes(macho().subarray(0, 12), limits), /Truncated/u);
  const command = macho(); command.writeUInt32LE(7, 36);
  assert.throws(() => inspectBytes(command, limits), /load command/u);
  const count = macho(); count.writeUInt32LE(9, 16);
  assert.throws(() => inspectBytes(count, limits), /command count/u);
  const offset = macho(); offset.writeUInt32LE(999, 56);
  assert.throws(() => inspectBytes(offset, limits), /symbol string/u);
  const name = macho(); name.fill(0x61, 73);
  assert.throws(() => inspectBytes(name, limits), /Unterminated/u);
});

test('PE, ELF and archive identification does not imply decompilation or unpacking', () => {
  const pe = Buffer.alloc(88); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('PE\0\0', 64); pe.writeUInt16LE(0x8664, 68);
  assert.equal(inspectBytes(pe, limits).format, 'PE');
  pe[65] = 0; assert.throws(() => inspectBytes(pe, limits), /PE signature/u);
  const elf = Buffer.alloc(20); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf); elf.writeUInt16LE(62, 18);
  assert.deepEqual({ format: inspectBytes(elf, limits).format, bits: inspectBytes(elf, limits).bits, machine: inspectBytes(elf, limits).machine }, { format: 'ELF', bits: 64, machine: 62 });
  const dmg = Buffer.alloc(520); dmg.write('koly', 8);
  assert.equal(inspectBytes(dmg, limits).format, 'UDIF-DMG');
  assert.equal(inspectBytes(Buffer.from('PKxx'), limits).format, 'ZIP');
  assert.equal(inspectBytes(Buffer.alloc(0), limits).format, 'unknown');
});

test('workspace inspection preserves bytes and refuses outside files, links, oversize and cancellation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'muse-reverse-'));
  const outside = await mkdtemp(join(tmpdir(), 'muse-reverse-outside-'));
  try {
    const source = macho(); await writeFile(join(workspace, 'sample'), source);
    const result = await inspectFile({ path: 'sample' }, workspace, limits, signal());
    assert.equal(result.totalSymbols, 1); assert.equal(result.bytes, source.length);
    assert.match(result.sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await readFile(join(workspace, 'sample')), source);
    await writeFile(join(outside, 'other'), source);
    await assert.rejects(inspectFile({ path: join(outside, 'other') }, workspace, limits, signal()), /inside/u);
    await assert.rejects(inspectFile({ path: 'sample' }, workspace, { ...limits, maxFileBytes: 10 }, signal()), /file limit/u);
    await assert.rejects(inspectFile({ path: 'sample', extra: true }, workspace, limits, signal()), /arguments/u);
    const abort = new AbortController(); abort.abort(new Error('cancel test'));
    await assert.rejects(inspectFile({ path: 'sample' }, workspace, limits, abort.signal), /cancel test/u);
    await symlink(join(outside, 'other'), join(workspace, 'link'), 'file');
    await assert.rejects(inspectFile({ path: 'link' }, workspace, limits, signal()), /Linked/u);
  } finally { await rm(workspace, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('refuses an ordinary file reached through a linked directory outside the workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'muse-reverse-linked-'));
  const outside = await mkdtemp(join(tmpdir(), 'muse-reverse-linked-outside-'));
  const directory = join(workspace, 'linked-directory');
  let linked = false;
  try {
    const source = macho(), target = join(outside, 'other');
    await writeFile(target, source);
    await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
    assert.equal((await lstat(directory)).isSymbolicLink(), true);
    assert.equal((await stat(join(directory, 'other'))).isFile(), true);
    assert.equal(await realpath(join(directory, 'other')), await realpath(target));
    await assert.rejects(inspectFile({ path: 'linked-directory/other' }, workspace, limits, signal()), /Linked/u);
    assert.deepEqual(await readFile(target), source);
  } finally {
    if (linked) await unlink(directory);
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('pinned route priorities select macOS and Rust and load actual portable resources', async () => {
  const table = JSON.parse(await readFile(join(resourceRoot, 'skills/config/routing.json'), 'utf8'));
  for (const route of Object.values(table.routes)) assert.ok((await readFile(join(resourceRoot, 'skills', route.skill), 'utf8')).length);
  assert.equal(selectRoute(table, 'macOS Mach-O offline static analysis').primary, 'R31');
  const rust = await routeTask('Rust binary stripped symbols', signal());
  assert.match(rust.label, /Rust/u); assert.ok(rust.instructions.includes('ACTION REQUIRED'));
  assert.equal(selectRoute(table, 'abcdefghijk').confidence, 'low');
  await assert.rejects(routeTask('', signal()), /non-empty/u);
  for (const setting of ['maxFileBytes', 'maxSymbols', 'timeoutMs']) assert.throws(() => resolveConfig({ [setting]: 0 }), /setting/u);
  assert.throws(() => resolveConfig({ assetRoot: 'relative' }), /resources/u);
  assert.throws(() => resolveConfig({ surprise: true }), /Unknown/u);
  assert.throws(() => resolveConfig(null), /object/u);
  const archiveModuleUrl = process.platform === 'win32'
    ? 'file:///C:/tmp/app.asar/node_modules/muse-reverse-tools/src/router.js'
    : 'file:///tmp/app.asar/node_modules/muse-reverse-tools/src/router.js';
  const archiveResourcePath = process.platform === 'win32'
    ? 'C:\\tmp\\app.asar.unpacked\\node_modules\\muse-reverse-tools\\resources\\reverse-skill\\'
    : '/tmp/app.asar.unpacked/node_modules/muse-reverse-tools/resources/reverse-skill/';
  assert.equal(resolveResourceRoot(archiveModuleUrl), archiveResourcePath);
});

test('session tools render real receipts and dispose all registrations', async () => {
  const registered = new Map(), cleanups = [];
  const ctx = { tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
    agents: { requireInitiator() { throw new Error('route must not inspect a session workspace'); } },
    effect(effect) { cleanups.push(effect()); } };
  apply(ctx);
  assert.deepEqual([...registered.keys()], ['reverse_skill', 'reverse_analyze']);
  const route = registered.get('reverse_skill');
  const receipt = await route.execute({ hint: 'macOS Mach-O' }, { signal: signal() });
  assert.equal(receipt.primary, 'R31');
  assert.equal(JSON.parse(route.output.render({}, receipt)[0].text).status, 'routed');
  assert.equal(route.presentCall().kind, 'read');
  await assert.rejects(route.execute({ hint: 'macOS', extra: true }, { signal: signal() }), /arguments/u);
  for (const dispose of cleanups.reverse()) await dispose();
  assert.equal(registered.size, 0);
});
