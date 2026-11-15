/** Explicit backend selection cannot silently fall back after an incomplete v2 deployment. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.js';

test('v2 selection requires both private runtime and state directories', () => {
  assert.equal(resolveConfig().legacyBackend, 'v1');
  for (const input of [{ legacyBackend: 'v3' }, { legacyBackend: 'v2' },
    { legacyBackend: 'v2', v2RuntimeDir: '/runtime' },
    { legacyBackend: 'v2', v2RuntimeDir: 'runtime', v2StateDir: '/state' },
    { v2Quality: 'auto' }, { v2PollIntervalMs: 0 }, { v2MaxPendingRequests: 0 }, { v2MaxPendingRequests: 1 }]) assert.throws(() => resolveConfig(input), TypeError);
  const config = resolveConfig({ legacyBackend: 'v2', v2RuntimeDir: '/runtime', v2StateDir: '/state' });
  assert.equal(config.legacyBackend, 'v2');
  assert.equal(config.v2Quality, '720p');
});
