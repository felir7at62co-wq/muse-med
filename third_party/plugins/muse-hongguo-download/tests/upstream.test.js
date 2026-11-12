/** Package integrity and offline engine load; no platform requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
test('retained source and runtime match the reviewed pin and load without external packages', async () => {
  await import('../scripts/verify-upstream.mjs');
  const engine = createRequire(import.meta.url)('../upstream/engine.cjs');
  for (const name of ['fetchEpisodeList', 'fetchPlayUrlSingle', 'deriveKey']) assert.equal(typeof engine[name], 'function');
});
