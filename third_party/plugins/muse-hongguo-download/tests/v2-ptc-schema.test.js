/** The registered v2 tool exposes cleanup failures to both PTC declaration formats. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.js';
import { HongguoDownloadClient } from '../src/client.js';
import { V2DownloadClient } from '../src/v2-download.js';
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '../../../../packages/core/tools/src/json-schema.ts';
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

test('health schema validates real wrapper results and projects distinct TS and Python health fields', async t => {
  const definitions = [], cleanup = [];
  const config = { legacyBackend: 'v2', v2RuntimeDir: '/fixture/runtime', v2StateDir: '/fixture/state' };
  apply({ subprocess: {}, tools: { register: value => { definitions.push(value); return () => {}; } },
    effect: callback => { const dispose = callback(); if (typeof dispose === 'function') cleanup.push(dispose); } }, config);
  t.after(async () => { await Promise.all(cleanup.map(dispose => dispose())); });
  const tool = definitions.find(row => row.name === 'hongguo_download_health');
  assert.ok(tool);
  const output = tool.output.schema;
  assertSupportedJsonSchema(output);
  const client = new HongguoDownloadClient(config, { subprocess: {} });
  const session = { sourceIdentity: 'a'.repeat(64), async start() {}, async dispose() {},
    async health() { return { engine: { engineVersion: 'fixture-1', protocol: 2, build: 1 },
      localLicenseStatus: { mode: 'Checking', reason: 'checking', refreshed: false } }; },
    async catalog(id) { return { seriesId: id, title: 'Fixture', episodeCount: 1,
      episodes: [{ index: 1, vid: 'fixture', title: 'Episode', durationSeconds: 1 }] }; } };
  client.v2 = new V2DownloadClient(client.config, { sessionFactory: async () => session });
  t.after(() => client.dispose());
  const local = await client.health({}), catalog = await client.health({ seriesIds: ['101'] });
  const failure = await client.health({ seriesIds: [] });
  for (const result of [local, catalog, failure]) assert.deepEqual(validateJsonSchemaValue(output, result), []);
  assert.equal(local.ok, true); assert.equal(catalog.ok, true); assert.equal(failure.ok, false);
  assert.notDeepEqual(validateJsonSchemaValue(output, { ...local, complete: true }), []);
  assert.notDeepEqual(validateJsonSchemaValue(output, { ...local, authorization: 'allowed' }), []);
  assert.notDeepEqual(validateJsonSchemaValue(output, { ...local, checks: undefined }), []);
  const sdkInput = [{ name: tool.name, description: tool.description, parameters: tool.parameters, output }];
  const ts = renderToolsSdk(sdkInput), py = renderToolsSdkPy(sdkInput);
  assert.match(ts, /runtimeIntegrity: "passed";/);
  assert.match(ts, /localLicenseStatus: \{/);
  assert.match(ts, /authorization: "not_checked";/);
  assert.doesNotMatch(ts, /\bcomplete\??:/);
  assert.match(py, /runtimeIntegrity: Literal\["passed"\]/);
  assert.match(py, /localLicenseStatus: HongguoDownloadHealthOutput1LocalLicenseStatus/);
  assert.match(py, /authorization: Literal\["not_checked"\]/);
  assert.doesNotMatch(py, /\bcomplete:/);
  const python = py.match(/```python\n([\s\S]*?)\n```/)[1];
  execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: python });
  const declarations = ts.match(/```ts\n([\s\S]*?)\n```/)[1];
  const dir = await mkdtemp(join(tmpdir(), 'muse-health-ptc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'health.ts');
  const program = `${declarations}\nasync function read() { const result = await tools.hongguo_download_health({}); if (result.ok) { const check: "passed" = result.checks.runtimeIntegrity; const version: string = result.engine.engineVersion; const mode: string = result.localLicenseStatus.mode; return [check, version, mode, result.authorization, result.mediaAvailability]; } return result.code; }\n`;
  await writeFile(file, program);
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const args = ['--ignoreConfig', '--noEmit', '--skipLibCheck', '--strict', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', file];
  const good = spawnSync(process.execPath, [tsc, ...args], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  await writeFile(file, `${program}\nasync function invalid() { const result = await tools.hongguo_download_health({}); if (result.ok) return result.complete; }\n`);
  const bad = spawnSync(process.execPath, [tsc, ...args], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /Property 'complete' does not exist/);
});
