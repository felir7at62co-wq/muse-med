/** The registered v2 tool exposes cleanup failures to both PTC declaration formats. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.js';
import { renderToolsSdk } from '../../../../packages/core/tool-executor-ptc/src/ts-types.ts';
import { renderToolsSdkPy } from '../../../../packages/core/tool-executor-ptc/src/py-types.ts';

test('projects the registered cleanup residual path into TypeScript and Python PTC output types', async () => {
  const definitions = [];
  const cleanup = [];
  const ctx = { subprocess: {}, tools: { register: value => { definitions.push(value); return () => {}; } },
    effect: callback => { const dispose = callback(); if (typeof dispose === 'function') cleanup.push(dispose); } };
  apply(ctx, { legacyBackend: 'v2', v2RuntimeDir: '/fixture/runtime', v2StateDir: '/fixture/state' });
  try {
    const tool = definitions.find(row => row.name === 'hongguo_download');
    assert.ok(tool);
    const schema = { name: tool.name, description: tool.description, parameters: tool.parameters, output: tool.output.schema };
    assert.deepEqual(schema.output.properties.cleanupPendingPath, { type: 'string' });
    assert.match(renderToolsSdk([schema]), /cleanupPendingPath\?: string;/);
    assert.match(renderToolsSdkPy([schema]), /cleanupPendingPath: NotRequired\[str\]/);
  } finally { await Promise.all(cleanup.map(dispose => dispose())); }
});
