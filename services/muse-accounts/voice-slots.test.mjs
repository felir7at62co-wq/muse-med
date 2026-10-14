/** Shared registration races, durable outcomes and account/project access through the real HTTP route. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, writeFile, mkdir, rm, chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createVoiceSlots, createJubianVoiceVerifier, resolveVoiceSlotOptions} from './voice-slots.mjs';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';

const slot = {script_id: 42, character_id: 'li-jun', voice_period_id: 'adult', operation_key: 'original-registration'};
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return {promise, resolve}; };
const tag = value => `⟦muse-voice:v1:${Buffer.from(JSON.stringify([value.script_id, value.character_id, value.voice_period_id])).toString('base64url')}⟧`;
const asset = (value = slot, id = 51) => ({id, scriptId: value.script_id, assetType: 4, delFlag: 0, assetName: `李军成年 ${tag(value)}`, assetUrl: 'https://media.test/reference.wav'});
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-voice-slot-')); t.after(() => rm(root, {recursive: true, force: true}));
  const clock = {value: 1000}, calls = [];
  const configuration = {root, now: () => clock.value, reservationLeaseMs: 1000, lockWaitMs: 500, lockPollMs: 1,
    verifyProject: async value => { calls.push({kind: 'project', scriptId: value.scriptId}); },
    verifyAsset: async value => { calls.push({kind: 'asset', assetId: value.assetId}); return asset(slot, value.assetId); }, ...options};
  const service = createVoiceSlots(configuration); await service.ready();
  const request = (action, values = {}, owner = 'alice', token = 'private-test-token') => service.request(owner, token, {...slot, action, ...values});
  return {root, clock, calls, service, request, restart: () => createVoiceSlots(configuration)};
}
async function claimed(f, owner = 'alice') { const reservation = await f.request('acquire', {}, owner); return {...slot, lease_id: reservation.lease_id}; }

test('two service instances reserve one slot across Muse accounts and disclose no other lease', async t => {
  const f = await fixture(t), other = f.restart(); await other.ready();
  const [one, two] = await Promise.all([f.request('acquire'), other.request('bob', 'other-private-token', {...slot, action: 'acquire', operation_key: 'bob-original'})]);
  assert.deepEqual([one.state, two.state].sort(), ['busy', 'reserved']);
  const loser = one.state === 'busy' ? one : two; assert.equal(loser.blocking_state, 'reserved'); assert.equal(loser.lease_id, undefined);
  const contents = await Promise.all((await readdir(f.root)).filter(name => name.endsWith('.json')).map(name => readFile(join(f.root, name), 'utf8')));
  assert.equal(contents.length, 1); assert.doesNotMatch(contents[0], /private-test-token|other-private-token/);
});

test('independent Node processes grant only one first creation permission', async t => {
  const f = await fixture(t), children = [], results = [], module = new URL('./voice-slots.mjs', import.meta.url).href;
  t.after(async () => { for (const child of children) if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  const source = `import {createVoiceSlots} from ${JSON.stringify(module)}; const service=createVoiceSlots({root:process.argv[1],verifyProject:async()=>{},verifyAsset:async()=>{},lockWaitMs:2000,lockPollMs:1}); await service.ready(); process.send('ready'); await new Promise(resolve=>process.once('message',resolve)); const request={script_id:42,character_id:'li-jun',voice_period_id:'adult',operation_key:process.argv[2],action:'acquire'}; const claim=await service.request(process.argv[2],'process-token',request); const result=claim.state==='reserved'?await service.request(process.argv[2],'process-token',{...request,action:'start',lease_id:claim.lease_id}):claim; process.send(result); process.disconnect();`;
  for (const name of ['alice', 'bob']) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.root, name], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']}); children.push(child);
    let stderr = ''; child.stderr.on('data', value => { stderr += value; });
    const ready = deferred(), done = deferred(); child.on('message', value => { if (value === 'ready') ready.resolve(); else { results.push(value); done.resolve(); } });
    child.on('exit', code => { if (code !== 0) { ready.resolve(); done.resolve(); } });
    child.ready = ready.promise; child.done = done.promise; child.diagnostics = () => stderr;
  }
  await Promise.all(children.map(child => child.ready)); children.forEach(child => child.send('go'));
  await Promise.all(children.map(child => child.done));
  assert.equal(results.filter(value => value.started_now === true).length, 1, children.map(child => child.diagnostics()).join('\n'));
  assert.equal(results.filter(value => value.state === 'busy').length, 1);
  await Promise.all(children.map(child => child.exitCode === null ? once(child, 'exit') : undefined));
  const restarted = f.restart(); await restarted.ready();
  const afterExit = await restarted.request('third-collaborator', 'new-token', {...slot, action: 'acquire'});
  assert.equal(afterExit.state, 'busy'); assert.equal(afterExit.blocking_state, 'submitted');
});

test('original lease permits creation once and submitted ownership survives expiry and restart', async t => {
  const f = await fixture(t), lease = await claimed(f);
  const [one, two] = await Promise.all([f.request('start', lease), f.request('start', lease)]);
  assert.equal([one, two].filter(value => value.started_now).length, 1);
  f.clock.value += 100000;
  const restarted = f.restart(); await restarted.ready();
  const repeat = await restarted.request('alice', 'new-provider-token', {...lease, action: 'acquire'});
  assert.equal(repeat.state, 'submitted'); assert.equal(repeat.lease_id, lease.lease_id);
  const other = await restarted.request('bob', 'bob-token', {...slot, action: 'acquire'});
  assert.equal(other.state, 'busy'); assert.equal(other.blocking_state, 'submitted');
  await assert.rejects(f.request('abandon', lease), {code: 'submitted_registration'});
  await assert.rejects(f.request('complete', {...lease, asset_id: 51}, 'bob'), {code: 'lease_conflict'});
});

test('unused reservation expiry and explicit abandonment never permit the expired lease to start', async t => {
  const f = await fixture(t), old = await claimed(f); f.clock.value += 1001;
  assert.equal((await f.request('read')).state, 'available');
  const next = await f.request('acquire', {}, 'bob'); assert.notEqual(next.lease_id, old.lease_id);
  await assert.rejects(f.request('start', old), {code: 'lease_conflict'});
  assert.equal((await f.request('abandon', {lease_id: next.lease_id}, 'bob')).state, 'available');
  const last = await f.request('acquire'); assert.equal(last.state, 'reserved');
  await assert.rejects(f.request('complete', {lease_id: last.lease_id, asset_id: 51}), {code: 'registration_not_started'});
});

test('complete and reuse reverify exact remote voice and preserve ready asset identity', async t => {
  const f = await fixture(t), lease = await claimed(f); await f.request('start', lease);
  const complete = await f.request('complete', {...lease, asset_id: 51});
  assert.equal(complete.state, 'ready'); assert.equal(complete.asset.voice_slot_tag, tag(slot));
  const repeat = await f.request('complete', {...lease, asset_id: 51}); assert.deepEqual(repeat, complete);
  const other = await f.request('acquire', {}, 'bob'); assert.equal(other.state, 'ready'); assert.equal(other.lease_id, undefined); assert.equal(other.asset.asset_id, 51);
  assert.equal((await f.request('start', lease)).started_now, false);
  await assert.rejects(f.request('complete', {...lease, asset_id: 52}), {code: 'asset_conflict'});
  assert.equal(f.calls.filter(value => value.kind === 'asset').length, 4);
});

test('project and life-period slot identities are independent', async t => {
  const f = await fixture(t);
  const one = await f.request('acquire'), child = await f.request('acquire', {voice_period_id: 'child'}), otherProject = await f.request('acquire', {script_id: 43});
  assert.equal(child.state, 'reserved'); assert.equal(otherProject.state, 'reserved');
  assert.notEqual(one.lease_id, child.lease_id); assert.equal((await readdir(f.root)).length, 3);
});

test('wrong remote project, category, identity or URL never settles or releases a submitted receipt', async t => {
  let response = asset(); const f = await fixture(t, {verifyAsset: async () => response}), lease = await claimed(f); await f.request('start', lease);
  for (const change of [{scriptId: 99}, {assetType: 1}, {id: 52}, {delFlag: 1}, {delFlag: 'unreadable'}, {assetName: `wrong ${tag({...slot, voice_period_id: 'child'})}`}, {assetName: 'same human name'}, {assetUrl: 'http://media.test/ref.wav'}, {assetUrl: 'https://user:password@media.test/ref.wav'}, {assetUrl: 'https://media.test/ref.wav#fragment'}, {assetUrl: null}]) {
    response = {...asset(), ...change}; await assert.rejects(f.request('complete', {...lease, asset_id: 51}), {code: 'asset_unverified'});
  }
  assert.equal((await f.request('read')).state, 'submitted'); response = {...asset(), delFlag: '0'}; await f.request('complete', {...lease, asset_id: 51});
  response = null; await assert.rejects(f.request('acquire', {}, 'bob'), {code: 'asset_unverified'});
});

test('ready requires explicit live evidence and consistent wire aliases without releasing the original registration', async t => {
  let response = asset(); const f = await fixture(t, {verifyAsset: async () => response}), lease = await claimed(f); await f.request('start', lease);
  for (const change of [{delFlag: undefined}, {delFlag: null}, {delFlag: false}, {deleted: true}, {deleted: 1}, {deleted: '1'}, {deleted: null}, {deleted: 'unreadable'},
    {asset_id: 52}, {asset_id: null}, {script_id: 43}, {script_id: 'unreadable'}, {asset_type: 1}, {asset_type: '4'}]) {
    response = {...asset(), ...change}; await assert.rejects(f.request('complete', {...lease, asset_id: 51}), {code: 'asset_unverified'});
    assert.equal((await f.request('read')).state, 'submitted');
  }
  response = {...asset(), asset_id: '51', script_id: '42', asset_type: 4, delFlag: '0', deleted: false}; await f.request('complete', {...lease, asset_id: 51});
  response = {...asset(), delFlag: undefined};
  await assert.rejects(f.request('acquire', {}, 'bob'), {code: 'asset_unverified'});
  const saved = JSON.parse(await readFile(join(f.root, (await readdir(f.root)).find(name => name.endsWith('.json'))), 'utf8'));
  assert.equal(saved.state, 'ready'); assert.equal(saved.asset_id, 51);
  response = {...asset(), deleted: 0}; assert.equal((await f.request('acquire', {}, 'bob')).state, 'ready');
});

test('every operation verifies collaborator access and revocation during read cannot commit', async t => {
  const entered = deferred(), release = deferred(); let authorized = true;
  const f = await fixture(t, {verifyProject: async () => { entered.resolve(); await release.promise; }});
  const pending = f.service.request('alice', 'private-token', {...slot, action: 'acquire'}, {isAuthorized: () => authorized});
  await entered.promise; authorized = false; release.resolve(); await assert.rejects(pending, {status: 401, code: 'account_session_expired'});
  assert.deepEqual(await readdir(f.root), []);
  const denied = f.restart(); await denied.ready();
  await assert.rejects(denied.request('alice', 'private-token', {...slot, action: 'read'}, {isAuthorized: () => false}), {status: 401});
});

test('bounded filesystem lock rejects contention without stealing an interrupted writer', async t => {
  const f = await fixture(t, {lockWaitMs: 5, lockPollMs: 1}); await f.request('acquire');
  const receipt = (await readdir(f.root)).find(name => name.endsWith('.json')); await mkdir(join(f.root, receipt + '.lock'));
  await assert.rejects(f.request('read'), {status: 503, code: 'reservation_busy'});
  assert.equal(JSON.parse(await readFile(join(f.root, receipt), 'utf8')).state, 'reserved');
});

test('invalid requests, corrupt receipts and permissive private roots fail without provider-token output', async t => {
  const f = await fixture(t);
  for (const value of [{action: 'unknown'}, {script_id: '../outside'}, {character_id: ' '}, {voice_period_id: ''}, {operation_key: 'x\n'}, {extra: 'token'}, {lease_id: 'bad'}, {asset_id: 0}]) {
    await assert.rejects(f.request('acquire', value), {status: 400, code: 'invalid_request'});
  }
  await assert.rejects(f.request('start'), {code: 'invalid_request'});
  await assert.rejects(f.request('acquire', {}, 'alice', 'token\n'), {code: 'invalid_request'});
  await f.request('acquire'); const name = (await readdir(f.root))[0]; await writeFile(join(f.root, name), JSON.stringify({version: 99}), {mode: 0o600});
  await assert.rejects(f.request('read'), {status: 503, code: 'receipt_unreadable'});
  assert.throws(() => createVoiceSlots({root: 'relative', verifyProject: async () => {}, verifyAsset: async () => {}}), /configuration/);
  assert.throws(() => createVoiceSlots({root: f.root, verifyProject: async () => {}, verifyAsset: async () => {}, lockWaitMs: 1, lockPollMs: 2}), /configuration/);
  if (process.platform !== 'win32') { await chmod(f.root, 0o755); const unsafe = f.restart(); await assert.rejects(unsafe.ready(), /private/); }
});

test('fixed-origin verifier checks project identity, provider status, response bounds and exact GET paths', async () => {
  const calls = []; let body = {code: 200, data: {id: 42}}, status = 200;
  const verifier = createJubianVoiceVerifier({fetcher: async (url, options) => { calls.push({url, options}); return new Response(JSON.stringify(body), {status}); }});
  await verifier.verifyProject({token: 'private-token', scriptId: 42});
  body = [{code: 0, data: {code: 200, data: asset()}}]; assert.deepEqual(await verifier.verifyAsset({token: 'private-token', assetId: 51}), asset());
  assert.deepEqual(calls.map(value => value.url), ['https://web.jubianai.net/prod-api/aigc/script/42', 'https://web.jubianai.net/prod-api/aigc/asset/51']);
  assert.ok(calls.every(value => value.options.method === 'GET' && value.options.redirect === 'error'));
  for (const value of [{code: 200, data: {id: 99}}, {code: 200, data: {id: 42, scriptId: 99}}, {code: 200, data: {id: 42, scriptId: null}}, {code: 403, data: {id: 42}}, {id: 42}]) { body = value; await assert.rejects(verifier.verifyProject({token: 'private-token', scriptId: 42}), {status: 403}); }
  status = 401; await assert.rejects(verifier.verifyProject({token: 'private-token', scriptId: 42}), error => error.status === 403 && !error.message.includes('private-token'));
  const unavailable = createJubianVoiceVerifier({fetcher: async () => { throw Error('private-token upstream'); }}); await assert.rejects(unavailable.verifyProject({token: 'private-token', scriptId: 42}), error => error.status === 503 && !error.message.includes('private-token'));
  const bounded = createJubianVoiceVerifier({maximumBytes: 4, fetcher: async () => new Response(JSON.stringify({code: 200, data: {id: 42}}))}); await assert.rejects(bounded.verifyProject({token: 'token', scriptId: 42}), {status: 503});
  assert.equal(resolveVoiceSlotOptions({}), undefined);
  assert.deepEqual(resolveVoiceSlotOptions({MUSE_VOICE_SLOTS_DIR: '/private/voices', MUSE_VOICE_SLOTS_LEASE_MS: '50'}), {root: '/private/voices', reservationLeaseMs: 50, lockWaitMs: 10000, lockPollMs: 25, timeoutMs: 10000});
});

async function httpFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-voice-http-')); let server;
  t.after(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await rm(root, {recursive: true, force: true}); });
  const store = await openStore(join(root, 'accounts.json')); const alice = await store.create('alice', 'pw'); await store.create('bob', 'pw');
  const origin = 'https://muse.test'; server = createAccountServer({store, publicOrigin: origin, ...options});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options = {}) => fetch(base + path, {redirect: 'manual', ...options});
  const login = async username => { const result = await call('/login', {method: 'POST', headers: {origin}, body: new URLSearchParams({username, password: 'pw'})}); assert.equal(result.status, 303); return result.headers.get('set-cookie').split(';')[0]; };
  const invoke = (cookie, values = {}, headers = {}) => call('/api/jubian/voice-slots', {method: 'POST', headers: {cookie, origin, 'content-type': 'application/json', 'x-jubian-token': 'private-jubian-token', ...headers}, body: JSON.stringify({...slot, action: 'acquire', ...values})});
  return {store, alice, origin, call, login, invoke};
}

test('HTTP route supports cookie and bearer sessions, rejects CSRF and missing configuration', async t => {
  const calls = [], f = await httpFixture(t, {voiceSlots: {request: async (id, token, value, options) => { calls.push({id, token, value}); assert.equal(options.isAuthorized(), true); return {state: 'available'}; }}});
  assert.equal((await f.call('/api/jubian/voice-slots')).status, 401);
  const cookie = await f.login('alice'), bearer = cookie.slice(cookie.indexOf('=') + 1);
  assert.equal((await f.invoke(cookie)).status, 200);
  assert.equal((await f.invoke('', {}, {authorization: `Bearer ${bearer}`})).status, 200);
  assert.equal((await f.invoke(cookie, {}, {origin: 'https://evil.test'})).status, 403);
  assert.equal(calls.length, 2); assert.equal(calls[0].id, f.alice.id); assert.equal(calls[0].token, 'private-jubian-token');
  assert.equal((await f.invoke(cookie, {}, {'content-type': 'text/plain'})).status, 415);
  assert.equal((await f.call('/api/jubian/voice-slots', {headers: {cookie}})).status, 405);
  assert.equal((await f.call('/api/jubian/voice-slots', {method: 'POST', headers: {cookie, origin: f.origin, 'content-type': 'application/json'}, body: '{'})).status, 400);
  assert.equal((await f.call('/api/jubian/voice-slots', {method: 'POST', headers: {cookie, origin: f.origin, 'content-type': 'application/json'}, body: ' '.repeat(16385)})).status, 413);
  await f.call('/logout', {method: 'POST', headers: {cookie, origin: f.origin}}); assert.equal((await f.invoke('', {}, {authorization: `Bearer ${bearer}`})).status, 401);
  const absent = await httpFixture(t); assert.equal((await absent.invoke(await absent.login('alice'))).status, 503);
});

test('HTTP revocation while project verification is pending prevents durable registration', async t => {
  const entered = deferred(), release = deferred(), f = await fixture(t, {verifyProject: async () => { entered.resolve(); await release.promise; }});
  const http = await httpFixture(t, {voiceSlots: f.service}), cookie = await http.login('alice');
  const pending = http.invoke(cookie); await entered.promise;
  await http.store.setDisabled(http.alice.id, true); release.resolve(); const response = await pending;
  assert.equal(response.status, 401); assert.equal((await response.json()).error_code, 'account_session_expired'); assert.deepEqual(await readdir(f.root), []);
});

test('HTTP service errors are redacted unless they carry a stable public status', async t => {
  const f = await httpFixture(t, {voiceSlots: {request: async () => { throw Error('private-jubian-token'); }}}), cookie = await f.login('alice');
  const response = await f.invoke(cookie); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private-jubian-token/);
});
