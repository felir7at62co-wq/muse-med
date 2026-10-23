/* Owned passive launch observation. Replace the single JSON placeholder before loading. */
(function () {
  'use strict';

  const config = @@CONFIG@@;
  const state = {
    active: false,
    disposed: false,
    listener: null,
    timer: null,
    callbacks: 0,
    matched: 0,
    unmatched: 0,
    errors: 0,
    summary: null,
  };
  const fixedRva = 0x2ce7cf0;
  const locationLimit = 64;

  function emit(payload) {
    send(payload);
  }

  function dispose(reason) {
    if (state.disposed) return state.summary;
    state.disposed = true;
    state.active = false;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    let detached = true;
    let flushed = true;
    const listener = state.listener;
    state.listener = null;
    if (listener !== null) {
      try {
        listener.detach();
      } catch (error) {
        // Only cleanup completion is reportable, never native exception details.
        void error;
        detached = false;
      }
      try {
        Interceptor.flush();
      } catch (error) {
        void error;
        flushed = false;
      }
    }
    state.summary = {
      type: 'disposed', reason: reason,
      callbacks: state.callbacks, matched: state.matched,
      unmatched: state.unmatched, errors: state.errors,
      detached: detached, flushed: flushed,
    };
    emit(state.summary);
    return state.summary;
  }

  rpc.exports = { dispose: function () { return dispose('requested'); } };

  function integer(value, minimum, maximum) {
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  }

  function validConfig(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const names = ['expectedAppId', 'modulePath', 'loadStartRva', 'expectedEntryBytes',
      'durationMs', 'scanBytes', 'indirectSlots', 'maxEvents'];
    return Object.keys(value).every(function (key) { return names.includes(key); })
      && names.every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); })
      && typeof value.expectedAppId === 'string' && /^wx[0-9a-f]{16}$/.test(value.expectedAppId)
      && typeof value.modulePath === 'string' && /^[A-Za-z]:[\\/]/.test(value.modulePath)
      && !/[\x00\r\n]/.test(value.modulePath) && /[\\/]flue\.dll$/i.test(value.modulePath)
      && value.loadStartRva === fixedRva
      && typeof value.expectedEntryBytes === 'string' && /^[0-9a-f]{64}$/i.test(value.expectedEntryBytes)
      && integer(value.durationMs, 60000, 180000)
      && integer(value.scanBytes, 19, 2048)
      && integer(value.indirectSlots, 0, 64)
      && integer(value.maxEvents, 1, 64);
  }

  function normalizeModulePath(value) {
    return value.replace(/\//g, '\\').toLowerCase();
  }

  function fail(code) {
    state.errors++;
    emit({ type: 'observation-error', code: code });
    dispose('setup-rejected');
  }

  function bytesAt(address, length) {
    if (address.isNull()) throw new Error('unreadable');
    const buffer = address.readByteArray(length);
    if (buffer === null || buffer.byteLength !== length) throw new Error('unreadable');
    return new Uint8Array(buffer);
  }

  function tokenCharacter(byte) {
    return (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90)
      || (byte >= 97 && byte <= 122) || byte === 95;
  }

  function findIdentity(bytes, expected) {
    const offsets = [];
    for (let index = 0; index + expected.length < bytes.length; index++) {
      if (index > 0 && tokenCharacter(bytes[index - 1])) continue;
      if (tokenCharacter(bytes[index + expected.length])) continue;
      let matches = true;
      for (let next = 0; next < expected.length; next++) {
        if (bytes[index + next] !== expected[next]) { matches = false; break; }
      }
      if (matches) offsets.push(index);
    }
    return offsets;
  }

  function readScene(launch) {
    try {
      const first = launch.add(1472).readPointer();
      if (first.isNull()) return null;
      const remote = first.add(16).readPointer();
      if (remote.isNull()) return null;
      const scene = remote.add(456).readS32();
      return integer(scene, 1000, 2000) ? scene : null;
    } catch (error) {
      void error;
      return null;
    }
  }

  function observe(args, expected) {
    if (!state.active || state.disposed) return;
    state.callbacks++;
    try {
      const first = args[0].add(64).readPointer();
      if (first.isNull()) throw new Error('unreadable');
      const second = first.add(1536).readPointer();
      if (second.isNull()) throw new Error('unreadable');
      const launch = second.add(8).readPointer();
      const bytes = bytesAt(launch, config.scanBytes);
      const inlineOffsets = findIdentity(bytes, expected);
      const indirectOffsets = [];
      let indirectMatches = 0;
      for (let slot = 0; inlineOffsets.length === 0 && slot < config.indirectSlots && slot * 8 + 8 <= bytes.length; slot++) {
        const memberOffset = slot * 8;
        try {
          const pointer = launch.add(memberOffset).readPointer();
          if (pointer.isNull()) continue;
          const locations = findIdentity(bytesAt(pointer, 64), expected);
          indirectMatches += locations.length;
          for (const byteOffset of locations) {
            if (indirectOffsets.length < locationLimit) indirectOffsets.push({ memberOffset: memberOffset, byteOffset: byteOffset });
          }
          if (locations.length > 0) break;
        } catch (error) {
          // An unreadable candidate member supplies no identity; do not expose its value.
          void error;
        }
      }
      if (inlineOffsets.length > 0 || indirectMatches > 0) {
        state.matched++;
        emit({ type: 'target-launch', inlineOffsets: inlineOffsets.slice(0, locationLimit),
          indirectOffsets: indirectOffsets, locationsTruncated: inlineOffsets.length > locationLimit || indirectMatches > locationLimit,
          scene: readScene(launch) });
        dispose('target-observed');
      } else {
        state.unmatched++;
        emit({ type: 'unmatched', count: state.unmatched });
      }
    } catch (error) {
      void error;
      state.errors++;
      emit({ type: 'observation-error', code: 'launch-unreadable' });
    }
    if (!state.disposed && state.callbacks >= config.maxEvents) dispose('event-limit');
  }

  if (!validConfig(config)) { fail('invalid-config'); return; }
  if (Process.platform !== 'windows' || Process.arch !== 'x64' || Process.pointerSize !== 8) {
    fail('unsupported-platform'); return;
  }
  let module;
  try {
    module = Process.getModuleByName('flue.dll');
  } catch (error) {
    void error;
    fail('module-unavailable'); return;
  }
  if (normalizeModulePath(module.path) !== normalizeModulePath(config.modulePath)) {
    fail('module-path-mismatch'); return;
  }
  if (!Number.isSafeInteger(module.size) || config.loadStartRva + 32 > module.size) {
    fail('entry-outside-module'); return;
  }
  let address;
  try {
    address = module.base.add(config.loadStartRva);
    const bytes = bytesAt(address, 32);
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    if (hex !== config.expectedEntryBytes.toLowerCase()) { fail('entry-bytes-mismatch'); return; }
  } catch (error) {
    void error;
    fail('entry-unreadable'); return;
  }
  const expected = Array.from(config.expectedAppId, function (character) { return character.charCodeAt(0); });
  try {
    state.listener = Interceptor.attach(address, { onEnter: function (args) { observe(args, expected); } });
    state.timer = setTimeout(function () { dispose('watchdog'); }, config.durationMs);
    state.active = true;
    emit({ type: 'ready', passive: true, entryBytesVerified: true, modulePathMatched: true,
      durationMs: config.durationMs, maxCallbacks: config.maxEvents });
  } catch (error) {
    void error;
    fail('attach-failed');
  }
})();
