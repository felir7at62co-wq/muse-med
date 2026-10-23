/** Offline mocks exercise only the owned template; no Frida, target source, or native code executes. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const template = await readFile(new URL('./enable-target-debug.js', import.meta.url), 'utf8');
const appId = 'wx404dde55fb12df78';
const launchRva = 0x2ce7cf0, filterRva = 0x39789d0;
const entry = '415741565657534881ec9001000089d34889ce833d469bf00a020f8ff9010000';
const filterEntry = '5657534881ec900000004889ce488b05dc57110a4831e048898424880000000f';
const initialArgument = 0x1234567890abcd02n;
const config = { expectedAppId: appId, modulePath: 'C:\\verified-runtime\\flue.dll', loadStartRva: launchRva,
  expectedEntryBytes: entry, cdpFilterRva: filterRva, expectedFilterEntryBytes: filterEntry, durationMs: 180000, maxCallbacks: 64, expectedScenes: [1183] };

function harness(options = {}) {
  const events = [], reads = [], writes = [], attachments = [], detaches = [], timers = new Map();
  const pointerValues = new Map([[0x1040n, 0x2000n], [0x2600n, 0x3000n], [0x3008n, 0x4000n],
    [0x45c0n, 0x6000n], [0x6010n, 0x7000n], [0x8000n, 0x9000n]]);
  const integers = new Map([[0x71c8n, options.scene ?? 1183], [0x9008n, options.type ?? 6]]);
  const segments = [];
  const nativeCalls = [];
  let flushCount = 0;
  class Pointer {
    constructor(value) { this.value = BigInt(value); }
    add(value) { return new Pointer(this.value + BigInt(value)); }
    and(value) { return new Pointer(this.value & value.value); }
    or(value) { return new Pointer(this.value | value.value); }
    toUInt32() { return Number(this.value & 0xffffffffn); }
    isNull() { return this.value === 0n; }
    readPointer() {
      reads.push({ type: 'pointer', address: this.value });
      if (!pointerValues.has(this.value)) throw Error('private native pointer error');
      return new Pointer(pointerValues.get(this.value));
    }
    readByteArray(length) {
      reads.push({ type: 'bytes', address: this.value, length });
      const row = segments.find(segment => this.value >= segment.start
        && this.value + BigInt(length) <= segment.start + BigInt(segment.bytes.length));
      if (!row) throw Error('private native byte error');
      const start = Number(this.value - row.start), bytes = row.bytes.slice(start, start + length);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    readS32() { return this.readU32(); }
    readU32() {
      reads.push({ type: 'integer', address: this.value });
      if (!integers.has(this.value)) throw Error('private native integer error');
      return integers.get(this.value);
    }
    writeS32(value) {
      if (options.sceneWriteFails) throw Error('private native scene-write error');
      writes.push({ type: 'scene', value }); integers.set(this.value, value);
    }
    writeU32(value) {
      if (options.filterWriteFails) throw Error('private native filter-write error');
      writes.push({ type: 'filter', value }); integers.set(this.value, value);
    }
  }
  const base = 0x10000000n;
  segments.push({ start: base + BigInt(launchRva), bytes: Uint8Array.from(Buffer.from(options.entry ?? entry, 'hex')) });
  segments.push({ start: base + BigInt(filterRva), bytes: Uint8Array.from(Buffer.from(options.filterEntry ?? filterEntry, 'hex')) });
  for (const [offset, text, terminated] of [[152, options.firstAppId ?? appId, options.firstNul !== false],
    [184, options.secondAppId ?? appId, options.secondNul !== false]]) {
    const bytes = new Uint8Array(19); bytes.set(Buffer.from(text).subarray(0, 18)); bytes[18] = terminated ? 0 : 65;
    segments.push({ start: 0x4000n + BigInt(offset), bytes });
  }
  const handlers = new Map();
  const sandbox = {
    rpc: { exports: {} }, ptr: value => new Pointer(value),
    Process: { platform: options.platform ?? 'windows', arch: options.arch ?? 'x64', pointerSize: 8,
      getModuleByName(name) { assert.equal(name, 'flue.dll'); return { path: options.modulePath ?? config.modulePath,
        base: new Pointer(base), size: 0x10000000 }; } },
    Interceptor: {
      attach(address, callbacks) {
        const rva = Number(address.value - base); attachments.push(rva);
        if (options.attachFails === rva) throw Error('private native attach error');
        handlers.set(rva, callbacks);
        return { detach() { detaches.push(rva); if (options.detachFails === rva) throw Error('private native detach error'); } };
      },
      flush() { flushCount++; if (options.flushFails) throw Error('private native flush error'); },
      replace() { nativeCalls.push('replace'); throw Error('replacement forbidden'); },
    },
    send(payload, data) { assert.equal(data, undefined); events.push(JSON.parse(JSON.stringify(payload))); },
    setTimeout(callback, milliseconds) { const id = timers.size + 1; timers.set(id, { callback, milliseconds }); return id; },
    clearTimeout(id) { timers.delete(id); },
    Memory: { scan() { nativeCalls.push('scan'); throw Error('global scan forbidden'); } },
    NativeFunction() { nativeCalls.push('native'); throw Error('native call forbidden'); },
    wx: new Proxy({}, { get() { nativeCalls.push('wx'); throw Error('wx calls forbidden'); } }),
  };
  assert.equal(template.split('@@CONFIG@@').length, 2);
  vm.runInNewContext(template.replace('@@CONFIG@@', JSON.stringify({ ...config, ...options.config })), sandbox, { timeout: 1000 });
  function enterLaunch(argument = initialArgument) {
    const invocation = {};
    const values = [new Pointer(0x1000n), new Pointer(argument)];
    const args = new Proxy(values, { set(target, key, value) {
      assert.equal(key, '1');
      if (options.argumentWriteFails) throw Error('private native argument-write error');
      writes.push({ type: 'argument', value: value.value }); target[key] = value; return true;
    } });
    handlers.get(launchRva).onEnter.call(invocation, args);
    return { invocation, args };
  }
  function leaveLaunch(invocation) { handlers.get(launchRva).onLeave.call(invocation, new Pointer(0x123n)); }
  function enterFilter() { const invocation = {}; handlers.get(filterRva).onEnter.call(invocation); return invocation; }
  function leaveFilter(invocation, retval = 0x8000n) {
    const value = new Pointer(retval); handlers.get(filterRva).onLeave.call(invocation, value); assert.equal(value.value, retval);
  }
  return { events, reads, writes, attachments, detaches, timers, integers, pointerValues, nativeCalls,
    enterLaunch, leaveLaunch, enterFilter, leaveFilter,
    dispose() { return JSON.parse(JSON.stringify(sandbox.rpc.exports.dispose())); },
    get flushes() { return flushCount; },
  };
}

test('both entry guards and the exact full module path pass before either listener is attached', () => {
  for (const options of [{ modulePath: 'C:\\unrelated\\flue.dll' }, { entry: '00'.repeat(32) },
    { filterEntry: '00'.repeat(32) }, { platform: 'darwin' }, { arch: 'arm64' }]) {
    const h = harness(options);
    assert.deepEqual(h.attachments, []); assert.deepEqual(h.writes, []);
    assert.equal(h.events[0].type, 'observation-error');
  }
});

test('invalid duration, callback limit, identity or RVA fails closed without registering hooks', () => {
  for (const value of [{ durationMs: 59999 }, { durationMs: 14400001 }, { maxCallbacks: 16385 },
    { maxCallbacks: 0 }, { expectedScenes: null }, { expectedScenes: [999] }, { expectedScenes: [2001] }, { expectedAppId: 'wxwrong' }, { cdpFilterRva: 1 }, { loadStartRva: 2 }]) {
    const h = harness({ config: value }); assert.deepEqual(h.attachments, []); assert.deepEqual(h.writes, []);
    assert.equal(h.events[0].code, 'invalid-config');
  }
});

test('one or both wrong AppIDs, missing NUL or the wrong scene cause zero argument and object writes', () => {
  for (const options of [{ firstAppId: 'wx0000000000000000' }, { secondAppId: 'wx0000000000000000' },
    { firstAppId: 'wx0000000000000000', secondAppId: 'wx1111111111111111' },
    { firstNul: false }, { secondNul: false }, { scene: 1027 }]) {
    const h = harness(options); const call = h.enterLaunch(); h.leaveLaunch(call.invocation);
    const filter = h.enterFilter(); h.leaveFilter(filter);
    assert.deepEqual(h.writes, []); assert.equal(call.args[1].value, initialArgument);
    assert.equal(h.events.some(event => event.type === 'target-enabled'), false);
    h.dispose();
  }
});

test('an eligible invocation changes scene first and only the argument low byte, then disables launch hook after return', () => {
  const h = harness({ modulePath: 'c:/VERIFIED-RUNTIME/FLUE.DLL' });
  const call = h.enterLaunch();
  assert.deepEqual(h.writes, [{ type: 'scene', value: 1101 }, { type: 'argument', value: 0x1234567890abcd01n }]);
  assert.equal(call.args[1].value, 0x1234567890abcd01n);
  assert.deepEqual(h.detaches, []);
  h.enterLaunch(); assert.equal(h.writes.length, 2);
  h.leaveLaunch(call.invocation);
  assert.deepEqual(h.detaches, [launchRva]); assert.equal(h.flushes, 1);
  h.enterLaunch(); assert.equal(h.writes.length, 2);
  assert.equal(h.events.filter(event => event.type === 'target-enabled').length, 1);
  h.dispose(); assert.deepEqual(h.nativeCalls, []);
});

test('an already enabled argument low byte is not rewritten', () => {
  const h = harness(); const call = h.enterLaunch(0x1234567890abcd01n); h.leaveLaunch(call.invocation);
  assert.deepEqual(h.writes, [{ type: 'scene', value: 1101 }]);
  const result = h.dispose(); assert.equal(result.argumentWriteAttempted, false); assert.equal(result.argumentWrites, 0);
});

test('filter calls started before target enable remain read-only after target launch, and only type 6 is changed', () => {
  const h = harness(); const stale = h.enterFilter(); h.leaveFilter(stale);
  assert.equal(h.reads.some(read => read.address === 0x8000n), false);
  const oldInFlight = h.enterFilter(), call = h.enterLaunch(); h.leaveLaunch(call.invocation); h.leaveFilter(oldInFlight);
  assert.equal(h.writes.length, 2);
  h.leaveFilter(h.enterFilter()); assert.equal(h.integers.get(0x9008n), 0);
  assert.deepEqual(h.writes.at(-1), { type: 'filter', value: 0 });
  h.leaveFilter(h.enterFilter()); assert.equal(h.writes.length, 3);
  h.integers.set(0x9008n, 5); h.leaveFilter(h.enterFilter()); assert.equal(h.writes.length, 3);
  h.dispose();
});

test('a partial scene-then-argument failure reports confirmed writes and uncertainty without restoring or enabling filter', () => {
  const h = harness({ argumentWriteFails: true }); h.enterLaunch();
  assert.deepEqual(h.writes, [{ type: 'scene', value: 1101 }]);
  assert.equal(h.integers.get(0x71c8n), 1101);
  const result = h.dispose();
  assert.equal(result.sceneWrites, 1); assert.equal(result.argumentWrites, 0);
  assert.equal(result.sceneWriteAttempted, true); assert.equal(result.argumentWriteAttempted, true);
  assert.equal(result.writeOutcomeUnknown, true); assert.equal(result.eligibleLaunches, 1);
  h.leaveFilter(h.enterFilter()); assert.equal(h.writes.length, 1);
  assert.equal(h.events.some(event => event.type === 'target-enabled'), false);
});

test('scene-write failure prevents argument writes and records an uncertain attempted mutation', () => {
  const h = harness({ sceneWriteFails: true }); const call = h.enterLaunch();
  assert.deepEqual(h.writes, []); assert.equal(call.args[1].value, initialArgument);
  const result = h.dispose(); assert.equal(result.sceneWriteAttempted, true); assert.equal(result.sceneWrites, 0);
  assert.equal(result.argumentWriteAttempted, false); assert.equal(result.writeOutcomeUnknown, true);
});

test('an unreadable or failed filter result stops without raw exceptions or further changes', () => {
  for (const options of [{ filterWriteFails: true }, {}]) {
    const h = harness(options), call = h.enterLaunch(); h.leaveLaunch(call.invocation);
    if (!options.filterWriteFails) h.pointerValues.delete(0x8000n);
    h.leaveFilter(h.enterFilter());
    assert.equal(h.events.at(-1).type, 'disposed');
    assert.equal(JSON.stringify(h.events).includes('private'), false);
    assert.equal(h.dispose().filterPatches, 0);
  }
});

test('dispose detaches both stored listeners, flushes, clears watchdog and remains idempotent', () => {
  const h = harness(), first = h.dispose(), second = h.dispose();
  assert.deepEqual(first, second); assert.deepEqual(h.detaches, [launchRva, filterRva]);
  assert.equal(h.flushes, 1); assert.equal(h.timers.size, 0);
  const call = h.enterLaunch(); h.leaveLaunch(call.invocation); h.leaveFilter(h.enterFilter());
  assert.deepEqual(h.writes, []);
});

test('watchdog and callback bounds stop observation and cannot write on late filter returns', () => {
  const h = harness({ scene: 1027, config: { maxCallbacks: 1 } }); h.enterLaunch();
  assert.equal(h.events.at(-1).reason, 'callback-limit'); assert.deepEqual(h.writes, []);
  const timed = harness(), call = timed.enterLaunch(); timed.leaveLaunch(call.invocation);
  const filter = timed.enterFilter(), timer = [...timed.timers.values()][0];
  assert.equal(timer.milliseconds, 180000); timer.callback(); timed.leaveFilter(filter);
  assert.equal(timed.writes.length, 2); assert.equal(timed.events.at(-1).reason, 'watchdog');
});

test('partial hook installation and detach failures still clean other listeners and expose safe failure flags', () => {
  const partial = harness({ attachFails: launchRva });
  assert.deepEqual(partial.detaches, [filterRva]); assert.deepEqual(partial.writes, []);
  const failed = harness({ detachFails: launchRva }), result = failed.dispose();
  assert.equal(result.detached, false); assert.deepEqual(failed.detaches, [launchRva, filterRva]);
  assert.equal(failed.flushes, 1);
  assert.equal(JSON.stringify(failed.events).includes('private'), false);
});

test('safe events do not expose addresses, AppIDs, paths, raw memory, arguments or exception messages', () => {
  const h = harness(), call = h.enterLaunch(); h.leaveLaunch(call.invocation); h.leaveFilter(h.enterFilter()); h.dispose();
  const text = JSON.stringify(h.events);
  for (const value of [appId, '0x', 'C:', 'private', '1234567890abcd', 'retval', 'pointer']) assert.equal(text.includes(value), false);
  assert.deepEqual(h.nativeCalls, []);
});


test('the configured observed scene is exact and does not accept a previous entry scene', () => {
  const accepted = harness({ scene: 1256, config: { expectedScenes: [1256] } });
  const call = accepted.enterLaunch(); accepted.leaveLaunch(call.invocation);
  assert.equal(accepted.events.some(event => event.type === 'target-enabled' && event.sceneBefore === 1256), true);
  assert.ok(accepted.writes.length > 0); accepted.dispose();
  const rejected = harness({ scene: 1183, config: { expectedScenes: [1256] } });
  rejected.enterLaunch(); assert.deepEqual(rejected.writes, []); rejected.dispose();
});


test('both independently observed entry scenes can be configured and unknown scenes stay read only', () => {
  for (const scene of [1183, 1256, 1027]) {
    const h = harness({ scene, config: { expectedScenes: [1183, 1256] } });
    const call = h.enterLaunch(); h.leaveLaunch(call.invocation);
    assert.equal(h.events.some(event => event.type === 'target-enabled'), scene !== 1027);
    if(scene===1027)assert.deepEqual(h.writes, []);h.dispose();
  }
});


test('configured one-hour and four-hour lifetimes retain a bounded self-unload timer', () => {
  for (const durationMs of [3600000,14400000]) {
    const h = harness({config: {durationMs}});
    assert.equal(h.events.some(event => event.type === 'ready'), true);
    assert.equal([...h.timers.values()][0].milliseconds, durationMs);
    [...h.timers.values()][0].callback();
    assert.equal(h.events.some(event => event.type === 'disposed' && event.reason === 'watchdog'), true);
    assert.equal(h.timers.size, 0);
  }
  for (const durationMs of [59999,14400001,true]) {
    const h = harness({config: {durationMs}});
    assert.equal(h.events.some(event => event.type === 'observation-error' && event.code === 'invalid-config'), true);
    assert.deepEqual(h.attachments, []);
  }
});


test('long task callback limit is configurable but remains bounded and legacy 256 still works', () => {
  for (const maxCallbacks of [256,4096,16384]) {
    const h = harness({config: {maxCallbacks}});
    assert.equal(h.events.some(event => event.type === 'ready' && event.maxCallbacks === maxCallbacks), true);
    h.dispose();
  }
  for (const maxCallbacks of [0,16385,true]) {
    const h = harness({config: {maxCallbacks}});
    assert.equal(h.events.some(event => event.type === 'observation-error' && event.code === 'invalid-config'), true);
    assert.deepEqual(h.attachments, []);
  }
});
