/** Health API and registration preserve the distinction between local checks and live downloads. */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HongguoDownloadClient } from '../src/client.js';
import { apply } from '../src/index.js';

const v2Config = { legacyBackend: 'v2', v2RuntimeDir: join(tmpdir(), 'fixture-hongguo-runtime'),
  v2StateDir: join(tmpdir(), 'fixture-hongguo-state'), maxSeries: 2 };
const signal = () => new AbortController().signal;
const verdict = () => ({ ok: true, sourceBackend: 'v2', authorization: 'not_checked',
  mediaAvailability: 'not_tested', verifiedDownload: false, catalogs: [] });
function assertUnverified(result) {
  assert.equal(result.authorization, 'not_checked');
  assert.equal(result.mediaAvailability, 'not_tested');
  assert.equal(result.verifiedDownload, false);
  assert.equal(Object.hasOwn(result, 'complete'), false);
  assert.notEqual(result.fullSeriesAvailable, true);
}
function fixture(t, health = async () => verdict()) {
  const calls = [];
  const client = new HongguoDownloadClient(v2Config, { request() { assert.fail('Health must not perform an outer HTTP request'); } });
  client.v2 = {
    async health(options, active) { calls.push({ options, active }); return health(options, active); },
    info() { assert.fail('Health must not call info'); },
    download() { assert.fail('Health must not call download'); },
    async dispose() {},
  };
  client.info = () => assert.fail('Health must not route through info');
  client.download = () => assert.fail('Health must not route through download');
  t.after(() => client.dispose());
  return { client, calls };
}

test('default health delegates only to the v2 health operation with an empty series list', async t => {
  const f = fixture(t);
  for (const result of [await f.client.health(), await f.client.health({}, signal())]) {
    assert.equal(result.ok, true);
    assertUnverified(result);
  }
  assert.deepEqual(f.calls.map(call => call.options), [{ seriesIds: [] }, { seriesIds: [] }]);
  for (const call of f.calls) { assert.ok(call.active instanceof AbortSignal); assert.equal(call.active.aborted, false); }
});

test('explicit IDs remain exact decimal strings and do not turn catalog checks into media verification', async t => {
  const f = fixture(t, async options => ({ ...verdict(), catalogs: options.seriesIds.map(seriesId => ({ seriesId,
    completeCatalog: true, mediaUrlsVerified: false, fullSeriesAvailable: null })) }));
  const ids = ['7702763145030290457', '123'];
  const result = await f.client.health({ seriesIds: ids });
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls[0].options.seriesIds, ids);
  assert.deepEqual(ids, ['7702763145030290457', '123']);
  assertUnverified(result);
  for (const catalog of result.catalogs) {
    assert.equal(catalog.completeCatalog, true);
    assert.equal(catalog.mediaUrlsVerified, false);
    assert.equal(catalog.fullSeriesAvailable, null);
  }
});

for (const args of [null, [], '123', { seriesIds: [] }, { seriesIds: ['1', '1'] },
  { seriesIds: ['1', '2', '3'] }, { seriesIds: '123' }, { seriesIds: [123] }, { seriesIds: [''] },
  { seriesIds: ['-1'] }, { seriesIds: [' 1'] }, { seriesIds: ['1/2'] }, { seriesIds: ['1'.repeat(31)] },
  { sourceMode: 'public' }, { seriesIds: ['1'], outputDir: '/not-a-health-argument' }]) {
  test(`health rejects invalid or unsupported arguments before backend work: ${JSON.stringify(args)}`, async t => {
    const f = fixture(t);
    const result = await f.client.health(args);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_arguments');
    assert.equal(f.calls.length, 0);
    assertUnverified(result);
  });
}

test('the outer health API cannot upgrade backend health flags into authorization or completion claims', async t => {
  const f = fixture(t, async () => ({ ok: true, complete: true, authorization: 'allowed',
    mediaAvailability: 'verified', verifiedDownload: true }));
  const result = await f.client.health({});
  assert.equal(result.ok, true);
  assertUnverified(result);
});

test('a health backend failure retains unknown authorization and fixed safe error output', async t => {
  const privateDiagnostic = 'fixture-private-device-cookie-signature';
  const f = fixture(t, async () => { throw new Error(privateDiagnostic); });
  const result = await f.client.health({});
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(privateDiagnostic), false);
  assertUnverified(result);
});

test('health on v1 returns an explicit unsupported result without touching source or download paths', async t => {
  const client = new HongguoDownloadClient({}, { request() { assert.fail('Unexpected network'); },
    subprocess: { spawn() { assert.fail('Unexpected process'); } } });
  t.after(() => client.dispose());
  const result = await client.health({});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'health_not_supported');
  assertUnverified(result);
});

test('an already aborted health call returns cancellation without starting backend work', async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  const result = await f.client.health({}, controller.signal);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cancelled');
  assert.equal(f.calls.length, 0);
  assertUnverified(result);
});

function registered(config = {}) {
  const tools = [], cleanup = [];
  apply({
    agents: { requireInitiator() { assert.fail('Read-only health does not require a session initiator'); } },
    get() { assert.fail('Health does not resolve a workspace write policy'); },
    subprocess: { spawn() { assert.fail('The registration fixture must not spawn native processes'); } },
    tools: { register(definition) { tools.push(definition); return () => {}; } },
    effect(factory) { cleanup.push(factory()); },
  }, config);
  return { tools, dispose: () => Promise.all(cleanup.map(dispose => dispose())) };
}

test('v2 registers a read-only health tool that accepts an empty object before initiator lookup', async t => {
  const original = HongguoDownloadClient.prototype.health;
  let invoked = 0;
  HongguoDownloadClient.prototype.health = async function(args, active) {
    invoked++; assert.deepEqual(args, {}); assert.ok(active instanceof AbortSignal); return verdict();
  };
  t.after(() => { HongguoDownloadClient.prototype.health = original; });
  const registration = registered(v2Config); t.after(registration.dispose);
  assert.deepEqual(registration.tools.map(tool => tool.name), ['hongguo_download_info', 'hongguo_download', 'hongguo_download_health']);
  const tool = registration.tools.find(tool => tool.name === 'hongguo_download_health');
  assert.deepEqual(tool.parameters.required, []);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.parameters.properties), ['seriesIds']);
  assert.equal(tool.presentCall().kind, 'read');
  const result = await tool.execute({}, { signal: signal() });
  assert.equal(invoked, 1); assertUnverified(result);
  const rendered = tool.output.render({}, result);
  assert.equal(rendered[0].type, 'text');
  assert.deepEqual(JSON.parse(rendered[0].text), result);
});

test('v1 scopes retain the original tool list without exposing health', async t => {
  for (const config of [{}, { legacyBackend: 'v1' }]) {
    const registration = registered(config); t.after(registration.dispose);
    assert.deepEqual(registration.tools.map(tool => tool.name), ['hongguo_download_info', 'hongguo_download']);
  }
});
