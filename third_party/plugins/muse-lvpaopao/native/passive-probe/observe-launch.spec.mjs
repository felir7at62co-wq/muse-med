/** Offline Node mocks execute only the owned observer, never target code or a live Frida process. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const template = await readFile(new URL('./observe-launch.js', import.meta.url), 'utf8');
const expected = 'wx404dde55fb12df78';
const entryHex = '415741565657534881ec9001000089d34889ce833d469bf00a020f8ff9010000';
const config = { expectedAppId: expected, modulePath: 'C:\\runtime\\flue.dll', loadStartRva: 0x2ce7cf0,
  expectedEntryBytes: entryHex, durationMs: 120000, scanBytes: 2048, indirectSlots: 64, maxEvents: 16 };

function harness(options = {}) {
  const reads = [], effects = [], payloads = [], timers = new Map(), segments = [], pointers = new Map(), integers = new Map();
  let callbacks;
  let disposed = 0;
  let flushes = 0;
  class Pointer {
    constructor(value) { this.value = value; }
    add(offset) { assert.equal(typeof offset, 'number'); return new Pointer(this.value + offset); }
    isNull() { return this.value === 0; }
    readPointer() {
      reads.push({ kind: 'pointer', address: this.value });
      if (!pointers.has(this.value)) throw Error('private pointer 0xdeadbeef');
      return new Pointer(pointers.get(this.value));
    }
    readS32() {
      reads.push({ kind: 'integer', address: this.value });
      if (!integers.has(this.value)) throw Error('private integer 0xdeadbeef');
      return integers.get(this.value);
    }
    readByteArray(length) {
      reads.push({ kind: 'bytes', address: this.value, length });
      const segment = segments.find(row => this.value >= row.base && this.value + length <= row.base + row.bytes.length);
      if (!segment) throw Error('private memory 0xdeadbeef');
      const bytes = segment.bytes.slice(this.value - segment.base, this.value - segment.base + length);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    writeInt() { effects.push('write'); throw Error('writes forbidden'); }
    writePointer() { effects.push('write'); throw Error('writes forbidden'); }
  }
  const entry = options.entryHex ?? entryHex;
  segments.push({ base: 0x10000000 + config.loadStartRva, bytes: Uint8Array.from(Buffer.from(entry, 'hex')) });
  pointers.set(0x1000 + 64, 0x2000);
  pointers.set(0x2000 + 1536, 0x3000);
  pointers.set(0x3000 + 8, 0x4000);
  pointers.set(0x4000 + 1472, 0x6000);
  pointers.set(0x6000 + 16, 0x7000);
  integers.set(0x7000 + 456, options.scene ?? 1027);
  const launch = new Uint8Array(2048);
  if (options.inline !== undefined) launch.set(Buffer.from(options.inline), options.inlineOffset ?? 600);
  segments.push({ base: 0x4000, bytes: launch });
  if (options.indirect !== undefined) {
    const indirect = new Uint8Array(64);
    indirect.set(Buffer.from(options.indirect));
    pointers.set(0x4000 + (options.memberOffset ?? 24), 0x5000);
    segments.push({ base: 0x5000, bytes: indirect });
  }
  const sandbox = {
    send(payload, binary) {
      assert.equal(binary, undefined);
      payloads.push(JSON.parse(JSON.stringify(payload)));
    },
    rpc: { exports: {} },
    Process: { platform: options.platform ?? 'windows', arch: options.arch ?? 'x64', pointerSize: 8,
      getModuleByName(name) {
        assert.equal(name, 'flue.dll');
        return { path: options.modulePath ?? config.modulePath, base: new Pointer(0x10000000), size: 0x10000000 };
      } },
    Interceptor: {
      attach(address, handlers) {
        effects.push('attach'); assert.equal(address.value, 0x10000000 + config.loadStartRva);
        assert.deepEqual(Object.keys(handlers), ['onEnter']); callbacks = handlers;
        return { detach() { disposed++; if (options.detachFails) throw Error('private detach failure'); } };
      },
      flush() { flushes++; if (options.flushFails) throw Error('private flush failure'); },
      replace() { effects.push('replace'); throw Error('replacement forbidden'); },
    },
    setTimeout(callback, milliseconds) { const key = timers.size + 1; timers.set(key, { callback, milliseconds }); return key; },
    clearTimeout(key) { timers.delete(key); },
    Memory: { scan() { effects.push('scan'); throw Error('global scan forbidden'); } },
    NativeFunction() { effects.push('native-call'); throw Error('native calls forbidden'); },
    wx: new Proxy({}, { get() { effects.push('wx'); throw Error('wx calls forbidden'); } }),
  };
  const value = { ...config, ...options.config };
  assert.equal(template.split('@@CONFIG@@').length, 2);
  vm.runInNewContext(template.replace('@@CONFIG@@', JSON.stringify(value)), sandbox, { timeout: 1000 });
  return { payloads, reads, effects, timers, pointers, integers,
    callback() { assert.ok(callbacks); const args = Object.freeze([new Pointer(0x1000), Object.freeze({ debug: 'unchanged' })]); callbacks.onEnter(args); },
    dispose() { return JSON.parse(JSON.stringify(sandbox.rpc.exports.dispose())); },
    get detached() { return disposed; }, get flushed() { return flushes; },
  };
}

test('module path mismatch rejects before hook registration and does not expose the other path', () => {
  const h = harness({ modulePath: 'C:\\private-account\\other\\flue.dll' });
  assert.deepEqual(h.effects, []);
  assert.equal(h.payloads[0].code, 'module-path-mismatch');
  assert.equal(JSON.stringify(h.payloads).includes('private-account'), false);
});

test('loaded entry bytes mismatch rejects before any launch memory read', () => {
  const h = harness({ entryHex: '00'.repeat(32) });
  assert.deepEqual(h.effects, []);
  assert.equal(h.payloads[0].code, 'entry-bytes-mismatch');
  assert.equal(h.reads.length, 1);
});

test('unsupported platform and invalid bounds cannot register a hook', () => {
  for (const options of [{ platform: 'darwin' }, { arch: 'arm64' }, { config: { durationMs: 59999 } },
    { config: { durationMs: 180001 } }, { config: { scanBytes: 2049 } }, { config: { indirectSlots: 65 } },
    { config: { maxEvents: 0 } }, { config: { expectedAppId: `${expected}x` } }, { config: { loadStartRva: 1 } }]) {
    const h = harness(options);
    assert.deepEqual(h.effects, []);
    assert.equal(h.payloads[0].type, 'observation-error');
  }
});

test('an exact inline identity emits offsets and plausible scene only, then disposes the sole listener', () => {
  const h = harness({ inline: expected, inlineOffset: 600 });
  h.callback(); h.callback();
  assert.deepEqual(h.effects, ['attach']);
  assert.deepEqual(h.payloads.map(payload => payload.type), ['ready', 'target-launch', 'disposed']);
  assert.deepEqual(h.payloads[1], { type: 'target-launch', inlineOffsets: [600], indirectOffsets: [],
    locationsTruncated: false, scene: 1027 });
  assert.equal(h.detached, 1); assert.equal(h.flushed, 1); assert.equal(h.timers.size, 0);
  assert.equal(h.reads.filter(read => read.kind === 'pointer' && read.address >= 0x4000 && read.address < 0x4200).length, 0);
  const output = JSON.stringify(h.payloads);
  for (const forbidden of [expected, '0x', 'private', 'C:', 'argv', 'pointer']) assert.equal(output.includes(forbidden), false);
});

test('Windows path case and slash variations are normalized before the exact full-path comparison', () => {
  const h = harness({ modulePath: 'c:/RUNTIME/FLUE.DLL', inline: expected });
  h.callback(); assert.equal(h.payloads[1].type, 'target-launch');
});

test('aligned pointer members read at most 64 bytes and report only member and byte offsets', () => {
  const h = harness({ indirect: expected, memberOffset: 24, scene: 999 });
  h.callback();
  assert.deepEqual(h.payloads[1], { type: 'target-launch', inlineOffsets: [],
    indirectOffsets: [{ memberOffset: 24, byteOffset: 0 }], locationsTruncated: false, scene: null });
  assert.deepEqual(h.reads.filter(read => read.kind === 'bytes').map(read => read.length), [32, 2048, 64]);
});

test('nonmatching launches and longer identifiers emit no identity, scene, or memory details', () => {
  for (const inline of ['wx0000000000000000', `${expected}a`, `a${expected}`]) {
    const h = harness({ inline }); h.callback();
    assert.deepEqual(h.payloads[1], { type: 'unmatched', count: 1 });
    assert.equal(h.reads.some(read => read.kind === 'integer'), false);
    h.dispose();
  }
});

test('bad launch pointers yield a fixed error code without exposing exception messages', () => {
  const h = harness(); h.pointers.delete(0x1000 + 64); h.callback();
  assert.deepEqual(h.payloads[1], { type: 'observation-error', code: 'launch-unreadable' });
  assert.equal(JSON.stringify(h.payloads).includes('deadbeef'), false); h.dispose();
});

test('callback limits and the bounded watchdog both detach without further observation', () => {
  const h = harness({ config: { maxEvents: 2 } }); h.callback(); h.callback(); h.callback();
  assert.deepEqual(h.payloads.map(payload => payload.type), ['ready', 'unmatched', 'unmatched', 'disposed']);
  assert.equal(h.payloads.at(-1).callbacks, 2); assert.equal(h.detached, 1);
  const timed = harness();
  const timer = [...timed.timers.values()][0]; assert.equal(timer.milliseconds, 120000);
  timer.callback(); timed.callback();
  assert.equal(timed.payloads.at(-1).reason, 'watchdog'); assert.equal(timed.detached, 1);
  assert.equal(timed.reads.length, 1);
});

test('explicit dispose is idempotent and performs no additional reads or detach calls', () => {
  const h = harness(); const first = h.dispose(); const second = h.dispose();
  assert.deepEqual(second, first); h.callback();
  assert.equal(h.detached, 1); assert.equal(h.flushed, 1); assert.equal(h.timers.size, 0);
  assert.deepEqual(h.payloads.map(payload => payload.type), ['ready', 'disposed']);
  assert.equal(h.reads.length, 1);
});

test('cleanup reports detach or flush failure without raw errors or repeated cleanup calls', () => {
  for (const options of [{ detachFails: true }, { flushFails: true }]) {
    const h = harness(options); const result = h.dispose(); h.dispose(); h.callback();
    assert.equal(result.detached, !options.detachFails);
    assert.equal(result.flushed, !options.flushFails);
    assert.equal(h.detached, 1); assert.equal(h.flushed, 1);
    assert.equal(h.timers.size, 0); assert.equal(h.reads.length, 1);
    assert.equal(JSON.stringify(h.payloads).includes('private'), false);
  }
});

test('scene reads happen only after identity match, and implausible or unreadable scenes remain null', () => {
  for (const scene of [999, 2001]) {
    const h = harness({ inline: expected, scene }); h.callback();
    assert.equal(h.payloads[1].scene, null);
  }
  const h = harness({ inline: expected }); h.pointers.delete(0x4000 + 1472); h.callback();
  assert.equal(h.payloads[1].type, 'target-launch'); assert.equal(h.payloads[1].scene, null);
});
