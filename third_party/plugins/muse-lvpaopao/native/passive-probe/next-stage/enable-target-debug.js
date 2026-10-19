/* Independently owned, one-shot target launch instrumentation. Template only until JSON is supplied. */
(function () {
  'use strict';
  const config = @@CONFIG@@;
  const state = {
    active: false, disposed: false, claimed: false, enabled: false,
    launchListener: null, filterListener: null, timer: null, summary: null,
    callbacks: 0, rejected: 0, filterCallbacks: 0, filterPatches: 0,
    sceneWrites: 0, argumentWrites: 0, sceneAttempted: false, argumentAttempted: false,
    filterWriteAttempts: 0, writeOutcomeUnknown: false, detached: true, flushed: true,
  };

  function emit(payload) { send(payload); }
  function flush() {
    try { Interceptor.flush(); }
    catch (error) { void error; state.flushed = false; }
  }
  function detach(name) {
    const listener = state[name];
    state[name] = null;
    if (listener === null) return;
    try { listener.detach(); }
    catch (error) { void error; state.detached = false; }
  }
  function dispose(reason) {
    if (state.disposed) return state.summary;
    state.disposed = true;
    state.active = false;
    state.enabled = false;
    if (state.timer !== null) { clearTimeout(state.timer); state.timer = null; }
    const hadListeners = state.launchListener !== null || state.filterListener !== null;
    detach('launchListener');
    detach('filterListener');
    if (hadListeners) flush();
    state.summary = { type: 'disposed', reason: reason, callbacks: state.callbacks,
      rejected: state.rejected, eligibleLaunches: state.claimed ? 1 : 0,
      sceneWriteAttempted: state.sceneAttempted, argumentWriteAttempted: state.argumentAttempted,
      sceneWrites: state.sceneWrites, argumentWrites: state.argumentWrites,
      filterCallbacks: state.filterCallbacks, filterWriteAttempts: state.filterWriteAttempts,
      filterPatches: state.filterPatches, writeOutcomeUnknown: state.writeOutcomeUnknown,
      detached: state.detached, flushed: state.flushed };
    emit(state.summary);
    return state.summary;
  }
  rpc.exports = { dispose: function () { return dispose('requested'); } };

  function fail(code, reason) {
    emit({ type: 'observation-error', code: code });
    dispose(reason);
  }
  function integer(value, minimum, maximum) {
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  }
  function validConfig(value) {
    const keys = ['expectedAppId', 'modulePath', 'loadStartRva', 'expectedEntryBytes',
      'cdpFilterRva', 'expectedFilterEntryBytes', 'durationMs', 'maxCallbacks', 'expectedScenes'];
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).every(function (key) { return keys.includes(key); })
      && keys.every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); })
      && typeof value.expectedAppId === 'string' && /^wx[0-9a-f]{16}$/.test(value.expectedAppId)
      && typeof value.modulePath === 'string' && /^[A-Za-z]:[\\/]/.test(value.modulePath)
      && !/[\x00\r\n]/.test(value.modulePath) && /[\\/]flue\.dll$/i.test(value.modulePath)
      && value.loadStartRva === 0x2ce7cf0 && value.cdpFilterRva === 0x39789d0
      && typeof value.expectedEntryBytes === 'string' && /^[a-f0-9]{64}$/i.test(value.expectedEntryBytes)
      && typeof value.expectedFilterEntryBytes === 'string' && /^[a-f0-9]{64}$/i.test(value.expectedFilterEntryBytes)
      && Array.isArray(value.expectedScenes) && value.expectedScenes.length >= 1 && value.expectedScenes.length <= 4
      && value.expectedScenes.every(function (scene) { return integer(scene, 1000, 2000); })
      && new Set(value.expectedScenes).size === value.expectedScenes.length
      && integer(value.durationMs, 60000, 600000) && integer(value.maxCallbacks, 1, 256);
  }
  function normalizePath(value) { return value.replace(/\//g, '\\').toLowerCase(); }
  function readBytes(address, count) {
    if (address.isNull()) throw Error('unreadable');
    const buffer = address.readByteArray(count);
    if (buffer === null || buffer.byteLength !== count) throw Error('unreadable');
    return new Uint8Array(buffer);
  }
  function matchingEntry(module, rva, expected) {
    if (!Number.isSafeInteger(module.size) || rva + 32 > module.size) return false;
    let actual = '';
    for (const byte of readBytes(module.base.add(rva), 32)) actual += byte.toString(16).padStart(2, '0');
    return actual === expected.toLowerCase();
  }
  function matchingIdentity(launch, offset, expected) {
    const bytes = readBytes(launch.add(offset), expected.length + 1);
    return bytes[expected.length] === 0
      && expected.every(function (byte, index) { return bytes[index] === byte; });
  }
  function takeCallback() {
    if (!state.active || state.disposed) return false;
    if (state.callbacks >= config.maxCallbacks) { dispose('callback-limit'); return false; }
    state.callbacks++;
    return true;
  }
  function limitAfterCallback() {
    if (!state.disposed && state.callbacks >= config.maxCallbacks) dispose('callback-limit');
  }

  if (!validConfig(config)) { fail('invalid-config', 'setup-rejected'); return; }
  if (Process.platform !== 'windows' || Process.arch !== 'x64' || Process.pointerSize !== 8) {
    fail('unsupported-platform', 'setup-rejected'); return;
  }
  let module;
  try { module = Process.getModuleByName('flue.dll'); }
  catch (error) { void error; fail('module-unavailable', 'setup-rejected'); return; }
  if (normalizePath(module.path) !== normalizePath(config.modulePath)) {
    fail('module-path-mismatch', 'setup-rejected'); return;
  }
  try {
    if (!matchingEntry(module, config.loadStartRva, config.expectedEntryBytes)) {
      fail('launch-entry-mismatch', 'setup-rejected'); return;
    }
    if (!matchingEntry(module, config.cdpFilterRva, config.expectedFilterEntryBytes)) {
      fail('filter-entry-mismatch', 'setup-rejected'); return;
    }
  } catch (error) { void error; fail('entry-unreadable', 'setup-rejected'); return; }
  const expected = Array.from(config.expectedAppId, function (character) { return character.charCodeAt(0); });

  function launchEnter(args) {
    this.eligible = false;
    if (state.claimed || !takeCallback()) return;
    let sceneAddress;
    let sceneBefore;
    let replacementArgument;
    let argumentNeeded;
    try {
      const first = args[0].add(64).readPointer();
      if (first.isNull()) throw Error('unreadable');
      const second = first.add(1536).readPointer();
      if (second.isNull()) throw Error('unreadable');
      const launch = second.add(8).readPointer();
      if (!matchingIdentity(launch, 152, expected) || !matchingIdentity(launch, 184, expected)) {
        state.rejected++; emit({ type: 'launch-rejected', count: state.rejected }); limitAfterCallback(); return;
      }
      const firstRemote = launch.add(1472).readPointer();
      if (firstRemote.isNull()) throw Error('unreadable');
      const remote = firstRemote.add(16).readPointer();
      if (remote.isNull()) throw Error('unreadable');
      sceneAddress = remote.add(456);
      sceneBefore = sceneAddress.readS32();
      if (!config.expectedScenes.includes(sceneBefore)) {
        state.rejected++; emit({ type: 'launch-rejected', count: state.rejected }); limitAfterCallback(); return;
      }
      argumentNeeded = args[1].and(ptr(255)).toUInt32() !== 1;
      replacementArgument = args[1].and(ptr('0xffffffffffffff00')).or(ptr(1));
    } catch (error) { void error; fail('launch-predicate-unreadable', 'launch-rejected'); return; }

    state.claimed = true;
    try {
      state.sceneAttempted = true;
      sceneAddress.writeS32(1101);
      state.sceneWrites++;
      if (argumentNeeded) {
        state.argumentAttempted = true;
        args[1] = replacementArgument;
        state.argumentWrites++;
      }
      state.enabled = true;
      this.eligible = true;
      emit({ type: 'target-enabled', sceneBefore: sceneBefore, sceneAfter: 1101, debugLowByte: 1, oneShot: true });
    } catch (error) {
      void error;
      state.writeOutcomeUnknown = true;
      fail('launch-write-failed', 'mutation-failed');
    }
  }
  function launchLeave() {
    if (!this.eligible || state.disposed) return;
    detach('launchListener');
    flush();
    emit({ type: 'launch-hook-disabled', detached: state.detached, flushed: state.flushed });
    if (!state.detached || !state.flushed) { dispose('cleanup-failed'); return; }
    limitAfterCallback();
  }
  function filterEnter() {
    this.eligible = state.active && !state.disposed && state.enabled;
  }
  function filterLeave(retval) {
    if (!this.eligible || !state.enabled || !takeCallback()) return;
    state.filterCallbacks++;
    let writing = false;
    try {
      if (retval.isNull()) { limitAfterCallback(); return; }
      const object = retval.readPointer();
      if (object.isNull()) { limitAfterCallback(); return; }
      const field = object.add(8);
      if (field.readU32() === 6) {
        state.filterWriteAttempts++;
        writing = true;
        field.writeU32(0);
        state.filterPatches++;
        emit({ type: 'cdp-filter-patched', count: state.filterPatches });
      }
    } catch (error) {
      void error;
      if (writing) state.writeOutcomeUnknown = true;
      fail(writing ? 'filter-write-failed' : 'filter-result-unreadable', 'filter-failed');
      return;
    }
    limitAfterCallback();
  }
  try {
    state.filterListener = Interceptor.attach(module.base.add(config.cdpFilterRva), { onEnter: filterEnter, onLeave: filterLeave });
    state.launchListener = Interceptor.attach(module.base.add(config.loadStartRva), { onEnter: launchEnter, onLeave: launchLeave });
    state.timer = setTimeout(function () { dispose('watchdog'); }, config.durationMs);
    state.active = true;
    emit({ type: 'ready', active: true, guardsVerified: true, durationMs: config.durationMs, maxCallbacks: config.maxCallbacks });
  } catch (error) { void error; fail('attach-failed', 'setup-rejected'); }
})();
