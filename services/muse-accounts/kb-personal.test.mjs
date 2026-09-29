import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createKbMcp} from './kb-mcp.mjs';
import {createAccountServer} from './gateway.mjs';
import {openStore} from './store.mjs';
import {verifyPersonalRoot} from './kb-personal.mjs';
import {loadDocumentGrants} from './kb-grants.mjs';

const secret = 'test-only-knowledge-base-secret-over-32-chars';
const editor = {id: '0123456789abcdef', username: 'editor', revision: 1, disabled: false};
const other = {id: 'fedcba9876543210', username: 'other', revision: 1, disabled: false};
const section = (title, text) => ({title, text, source: 'project/episode-01', reviewed: true});
const invoke = async (handle, token, name, args = {}) => {
  const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}});
  const response = await handle({method: 'POST', headers: {authorization: `Bearer ${token}`}, body});
  assert.equal(response.status, 200);
  return JSON.parse(response.body).result;
};

test('reviewed scripts are saved, searched, and read only by their owning account', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-personal-kb-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const shared = join(root, 'shared');
  const personal = join(root, 'personal');
  await mkdir(join(shared, 'raw', 'sources', 'SRC-2026-09-28-001'), {recursive: true});
  const sharedText = 'SHARED_APPROVED_SECRET';
  await writeFile(join(shared, 'raw', 'sources', 'SRC-2026-09-28-001', 'extracted.md'), sharedText);
  const hash = createHash('sha256').update(sharedText).digest('hex');
  const grants = new Map([['SRC-2026-09-28-001', {kind: 'knowledge', level: 'read', accounts: new Set([editor.id]), sha256: hash}]]);
  const accounts = {get: id => id === editor.id ? editor : id === other.id ? other : null};
  const handle = createKbMcp({vaultRoot: shared, personalRoot: personal, accounts, secret, documentGrants: grants,
    authorize: token => token === 'editor-token' ? {account: editor, mode: 'account'} : token === 'other-token' ? {account: other, mode: 'account'} : null});

  const saved = await invoke(handle, 'editor-token', 'ingest_script', {items: [section('第一集', '# 第一集\nSCENE_PRIVATE_MARKER\n人物：她发现失踪的母亲就在眼前。')]});
  assert.equal(saved.isError, undefined);
  const id = /id: (private\/SRC-\d{4}-\d{2}-\d{2}-\d{3})/.exec(saved.content[0].text)?.[1];
  assert.ok(id);
  assert.doesNotMatch(saved.content[0].text, /personal\\|personal\/|raw\/sources/);
  const duplicate = await invoke(handle, 'editor-token', 'ingest_script', {items: [section('第一集', '# 第一集\nSCENE_PRIVATE_MARKER\n人物：她发现失踪的母亲就在眼前。')]});
  assert.match(duplicate.content[0].text, /已存在/);
  assert.match(duplicate.content[0].text, new RegExp(id));
  const ownSearch = await invoke(handle, 'editor-token', 'search', {query: 'SCENE_PRIVATE_MARKER'});
  assert.match(ownSearch.content[0].text, new RegExp(id));
  assert.match((await invoke(handle, 'editor-token', 'read', {id})).content[0].text, /SCENE_PRIVATE_MARKER/);
  const otherSearch = await invoke(handle, 'other-token', 'search', {query: 'SCENE_PRIVATE_MARKER'});
  assert.doesNotMatch(otherSearch.content[0].text, /private\/SRC-|SCENE_PRIVATE_MARKER.*摘要/);
  assert.equal((await invoke(handle, 'other-token', 'read', {id})).isError, true);
  assert.doesNotMatch((await invoke(handle, 'other-token', 'search', {query: sharedText})).content[0].text, /SRC-2026-09-28-001|SHARED_APPROVED_SECRET.*摘要/);
  assert.match((await invoke(handle, 'editor-token', 'search', {query: sharedText})).content[0].text, /SRC-2026-09-28-001/);
  assert.equal((await invoke(handle, 'other-token', 'ingest', {text: 'Forbidden'})).isError, true);
  assert.match((await invoke(handle, 'editor-token', 'read_opening', {id})).content[0].text, /SCENE_PRIVATE_MARKER/);
  assert.equal((await invoke(handle, 'other-token', 'read_opening', {id})).isError, true);
  assert.match(await readFile(join(personal, editor.id, 'raw', 'sources', id.slice(8), 'extracted.md'), 'utf8'), /SCENE_PRIVATE_MARKER/);
});

test('partial script batches report each rejected section without claiming whole-archive success', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-personal-batch-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const account = {get: () => editor};
  const handle = createKbMcp({vaultRoot: join(root, 'shared'), personalRoot: join(root, 'personal'), accounts: account, secret,
    authorize: token => token === 'session' ? {account: editor, mode: 'account'} : null});
  const result = await invoke(handle, 'session', 'ingest_script', {items: [
    section('第一集', '第一集 已复核的剧本正文'),
    {...section('第二集', '不应入库'), source: '../escape'},
    {...section('第三集', '未校对内容'), reviewed: false},
    {...section('第四集', 'x'.repeat(400_001))},
  ]});
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /第 1 项：已写入/);
  for (const number of [2, 3, 4]) assert.match(result.content[0].text, new RegExp(`第 ${number} 项：失败`));
  assert.match(result.content[0].text, /失败项未入库/);
  assert.equal((await invoke(handle, 'session', 'read', {id: 'private/../../escape'})).isError, true);
  assert.equal((await invoke(handle, 'session', 'read', {id: 'private/SRC-2026-09-28-999'})).isError, true);
  const disabled = createKbMcp({vaultRoot: join(root, 'shared'), accounts: account, secret,
    authorize: token => token === 'session' ? {account: editor, mode: 'account'} : null});
  assert.equal((await invoke(disabled, 'session', 'ingest_script', {items: [section('稿件', '正文')]})).isError, true);
});

test('gateway account token can ingest privately and is revoked by logout', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-personal-session-'));
  const store = await openStore(join(root, 'accounts.json'));
  await store.create('editor', 'password');
  const server = createAccountServer({store, runtime: {ensure: async () => {throw Error('Unexpected workspace');}},
    publicOrigin: 'https://muse.test', environment: 'production',
    kb: {vaultRoot: join(root, 'shared'), personalRoot: join(root, 'personal'), secret, documentGrants: new Map()}});
  const base = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, {recursive: true, force: true});});
  const login = await fetch(base + '/login', {method: 'POST', headers: {origin: 'https://muse.test'}, body: new URLSearchParams({username: 'editor', password: 'password'}), redirect: 'manual'});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const access = await fetch(base + '/api/kb/access', {method: 'POST', headers: {origin: 'https://muse.test', cookie}});
  assert.equal(access.status, 200);
  const {token} = await access.json();
  const call = async (name, args) => {
    const response = await fetch(base + '/api/kb/mcp', {method: 'POST', headers: {authorization: `Bearer ${token}`}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})});
    return {status: response.status, result: (await response.json().catch(() => null))?.result};
  };
  assert.match((await call('ingest_script', {items: [section('视频第一集', 'REVOCATION_MARKER 正文')]})).result.content[0].text, /已写入/);
  assert.match((await call('search', {query: 'REVOCATION_MARKER'})).result.content[0].text, /private\/SRC-/);
  const logout = await fetch(base + '/logout', {method: 'POST', headers: {origin: 'https://muse.test', cookie}, redirect: 'manual'});
  assert.equal(logout.status, 303);
  assert.equal((await call('search', {query: 'REVOCATION_MARKER'})).status, 401);
});

test('personal root configuration rejects absent, nested, and shared vault paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-personal-root-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const shared = join(root, 'shared'), personal = join(root, 'personal');
  await mkdir(shared, {mode: 0o700});
  await mkdir(personal, {mode: 0o700});
  await verifyPersonalRoot(personal, shared);
  await assert.rejects(verifyPersonalRoot(undefined, shared), /owner-only absolute/);
  await assert.rejects(verifyPersonalRoot(join(shared, 'missing'), shared), /owner-only absolute/);
  await assert.rejects(verifyPersonalRoot(shared, shared), /separate/);
  await mkdir(join(shared, 'nested'), {mode: 0o700});
  await assert.rejects(verifyPersonalRoot(join(shared, 'nested'), shared), /separate/);
  if (process.platform !== 'win32') {
    await chmod(personal, 0o755);
    await assert.rejects(verifyPersonalRoot(personal, shared), /owner-only/);
    await chmod(personal, 0o700);
  }
});

test('shared document grants must remain outside the writable vault', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-grants-path-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const shared = join(root, 'shared'), admin = join(root, 'admin');
  await mkdir(shared);
  await mkdir(admin);
  const body = JSON.stringify({version: 1, grants: []});
  const inside = join(shared, 'grants.json'), outside = join(admin, 'grants.json');
  await writeFile(inside, body);
  await writeFile(outside, body);
  assert.equal((await loadDocumentGrants(outside, {vaultRoot: shared})).size, 0);
  await assert.rejects(loadDocumentGrants(inside, {vaultRoot: shared}), /outside the shared vault/);
  if (process.platform !== 'win32') {
    await chmod(outside, 0o666);
    await assert.rejects(loadDocumentGrants(outside, {vaultRoot: shared}), /administrator-maintained/);
  }
});
