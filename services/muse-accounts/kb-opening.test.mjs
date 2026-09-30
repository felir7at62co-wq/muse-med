import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createKbMcp} from './kb-mcp.mjs';
import {kbToken} from './kb-token.mjs';
import {readOpening, readDocumentPage} from './kb-vault.mjs';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {loadDocumentGrants} from './kb-grants.mjs';

const secret = 'test-only-knowledge-base-secret-over-32-chars';
const id = 'SRC-2026-09-28-001';
const account = {id: '0123456789abcdef', username: 'editor', revision: 1, disabled: false};

const documentPath = (root, documentId) => documentId.startsWith('wiki/')
  ? join(root, 'wiki', ...documentId.slice(5).split('/')) + '.md'
  : join(root, 'raw', 'sources', documentId, 'extracted.md');
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const granted = async (root, documentId, {kind = 'knowledge', level = 'read', accounts = new Set([account.id]), title} = {}) => ({
  kind, level, accounts, sha256: await sha256(documentPath(root, documentId)), ...(title === undefined ? {} : {title}),
});
const invoke = async (handle, name, args = {}) => {
  const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}});
  const response = await handle({method: 'POST', headers: {authorization: `Bearer ${kbToken(secret, account.id, account.revision)}`}, body});
  assert.equal(response.status, 200);
  return JSON.parse(response.body).result;
};

test('read_opening returns a bounded opening only for an explicitly granted account', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-opening-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const packet = join(root, 'raw', 'sources', id);
  await mkdir(packet, {recursive: true});
  const opening = '她在婚礼上发现请柬是伪造的。'.repeat(500);
  await writeFile(join(packet, 'extracted.md'), opening + 'LATE-SECRET');
  await writeFile(join(packet, 'manifest.json'), JSON.stringify({id, title: '爆款开头'}));
  const accounts = {get: accountId => accountId === account.id ? account : null};
  const handle = createKbMcp({vaultRoot: root, accounts, secret, documentGrants: new Map([[id, await granted(root, id, {kind: 'viral-script', level: 'opening'})]])});
  const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'read_opening', arguments: {id}}});
  const response = await handle({method: 'POST', headers: {authorization: `Bearer ${kbToken(secret, account.id, account.revision)}`}, body});
  assert.equal(response.status, 200);
  const result = JSON.parse(response.body).result;
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /SRC-2026-09-28-001/);
  assert.match(result.content[0].text, /她在婚礼上发现请柬/);
  assert.doesNotMatch(result.content[0].text, /LATE-SECRET/);
  assert.ok(result.content[0].text.length < 7000);
});

test('read_opening refuses an ungranted account and a request for a later range', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-denied-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const packet = join(root, 'raw', 'sources', id);
  await mkdir(packet, {recursive: true});
  await writeFile(join(packet, 'extracted.md'), 'PRIVATE OPENING');
  await writeFile(join(packet, 'manifest.json'), JSON.stringify({id, title: 'Private'}));
  const other = {id: 'fedcba9876543210', username: 'other', revision: 1, disabled: false};
  const accounts = {get: accountId => [account, other].find(item => item.id === accountId)};
  const handle = createKbMcp({vaultRoot: root, accounts, secret, documentGrants: new Map([[id, await granted(root, id, {kind: 'viral-script', level: 'opening'})]])});
  const invoke = async (actor, arguments_) => {
    const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'read_opening', arguments: arguments_}});
    const response = await handle({method: 'POST', headers: {authorization: `Bearer ${kbToken(secret, actor.id, actor.revision)}`}, body});
    return JSON.parse(response.body).result;
  };
  const denied = await invoke(other, {id});
  assert.equal(denied.isError, true);
  assert.doesNotMatch(denied.content[0].text, /PRIVATE OPENING|Private/);
  const range = await invoke(account, {id, offset: 6000});
  assert.equal(range.isError, true);
  assert.doesNotMatch(range.content[0].text, /PRIVATE OPENING/);
});

test('readOpening accepts a large script without exposing later content or traversing paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-large-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const packet = join(root, 'raw', 'sources', id);
  await mkdir(packet, {recursive: true});
  await writeFile(join(packet, 'extracted.md'), '开场'.repeat(3000) + '结尾秘密'.repeat(200_000));
  await writeFile(join(packet, 'manifest.json'), JSON.stringify({id, title: '长剧本'}));
  const fileHash = await sha256(documentPath(root, id));
  const result = await readOpening(root, id, {sha256: fileHash});
  assert.equal(Array.from(result.opening).length, 6000);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.opening, /结尾秘密/);
  assert.equal(await readOpening(root, '../../outside'), null);
  const later = await readDocumentPage(root, id, {start: 600000, sha256: fileHash});
  assert.equal(later.start, 600000);
  assert.equal(Array.from(later.body).length, 6000);
  assert.match(later.body, /结尾秘密/);
  const beforeOldLimit = await readDocumentPage(root, id, {start: 396000, sha256: fileHash});
  assert.equal(beforeOldLimit.nextStart, 402000);
  const afterOldLimit = await readDocumentPage(root, id, {start: beforeOldLimit.nextStart, sha256: fileHash});
  assert.equal(afterOldLimit.start, 402000);
  assert.equal(Array.from(afterOldLimit.body).length, 6000);
});

test('a logged-in account receives a short-lived read token that stops working on logout', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-session-'));
  const store = await openStore(join(root, 'accounts.json'));
  const actor = await store.create('editor', 'password');
  const packet = join(root, 'vault', 'raw', 'sources', id);
  await mkdir(packet, {recursive: true});
  await writeFile(join(packet, 'extracted.md'), '开头场景');
  await writeFile(join(packet, 'manifest.json'), JSON.stringify({id, title: '授权样本'}));
  const server = createAccountServer({
    store, runtime: {ensure: async () => { throw Error('Unexpected workroom request'); }},
    publicOrigin: 'https://muse.test', environment: 'production',
    kb: {vaultRoot: join(root, 'vault'), secret, documentGrants: new Map([[id, await granted(join(root, 'vault'), id, {kind: 'viral-script', level: 'opening', accounts: new Set([actor.id])})]])},
  });
  const base = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, {recursive: true, force: true});});
  const login = await fetch(base + '/login', {method: 'POST', headers: {origin: 'https://muse.test'}, body: new URLSearchParams({username: 'editor', password: 'password'}), redirect: 'manual'});
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const badOrigin = await fetch(base + '/api/kb/access', {method: 'POST', headers: {origin: 'https://other.test', cookie}, redirect: 'manual'});
  assert.equal(badOrigin.status, 403);
  const issued = await fetch(base + '/api/kb/access', {method: 'POST', headers: {origin: 'https://muse.test', cookie}});
  assert.equal(issued.status, 200);
  const {token, url, expiresAt} = await issued.json();
  assert.equal(url, 'https://muse.test/api/kb/mcp');
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 15 * 60_000);
  assert.ok(token && !cookie.includes(token));
  const call = async (name, args) => {
    const response = await fetch(base + '/api/kb/mcp', {method: 'POST', headers: {authorization: `Bearer ${token}`}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})});
    return {status: response.status, json: await response.json().catch(() => null)};
  };
  assert.match((await call('read_opening', {id})).json.result.content[0].text, /开头场景/);
  assert.equal((await call('ingest', {text: 'Forbidden'})).json.result.isError, true);
  const logout = await fetch(base + '/logout', {method: 'POST', headers: {origin: 'https://muse.test', cookie}, redirect: 'manual'});
  assert.equal(logout.status, 303);
  assert.equal((await call('read_opening', {id})).status, 401);
});

test('the last page of a maximum-size document does not advertise an unusable next start', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-max-page-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const packet = join(root, 'raw', 'sources', id);
  await mkdir(packet, {recursive: true});
  await writeFile(join(packet, 'extracted.md'), 'A'.repeat(4 * 1024 * 1024));
  await writeFile(join(packet, 'manifest.json'), JSON.stringify({id, title: '最大文档'}));
  const last = await readDocumentPage(root, id, {start: 4_194_000, sha256: await sha256(documentPath(root, id))});
  assert.equal(last.body.length, 304);
  assert.equal(last.sourceBytes, 4 * 1024 * 1024);
  assert.equal(last.truncated, false);
  assert.equal(last.nextStart, null);
});

test('read_opening exposes exact bounded ranges and a continuation before the opening limit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-range-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const packet = join(root, 'raw', 'sources', id);
  await mkdir(packet, {recursive: true});
  const content = '起'.repeat(6000) + '首个悬念' + '转'.repeat(17_996) + '后文秘密';
  await writeFile(join(packet, 'extracted.md'), content);
  await writeFile(join(packet, 'manifest.json'), JSON.stringify({id, title: '参考剧本'}));
  const handle = createKbMcp({vaultRoot: root, accounts: {get: () => account}, secret, documentGrants: new Map([[id, await granted(root, id, {kind: 'viral-script', level: 'opening', accounts: new Set(['*'])})]])});
  const call = async args => {
    const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'read_opening', arguments: args}});
    const response = await handle({method: 'POST', headers: {authorization: `Bearer ${kbToken(secret, account.id, account.revision)}`}, body});
    return JSON.parse(response.body).result;
  };
  const first = await call({id});
  assert.match(first.content[0].text, /已读字符范围: \[0, 6000\)/);
  assert.match(first.content[0].text, /下一段起点: 6000/);
  assert.doesNotMatch(first.content[0].text, /首个悬念/);
  const second = await call({id, start: 6000});
  assert.match(second.content[0].text, /已读字符范围: \[6000, 12000\)/);
  assert.match(second.content[0].text, /开头页码: 2\/4/);
  assert.match(second.content[0].text, /首个悬念/);
  const last = await call({id, start: 18000});
  assert.match(last.content[0].text, /达到开头上限: 是/);
  assert.doesNotMatch(last.content[0].text, /后文秘密/);
  assert.equal((await call({id, start: 24000})).isError, true);
  assert.equal((await call({id, start: 1})).isError, true);
});

test('a session read token searches only granted script sources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-search-scope-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const privateId = 'SRC-2026-09-28-002';
  for (const [sourceId, title] of [[id, '获授权样本'], [privateId, '私人剧本']]) {
    const packet = join(root, 'raw', 'sources', sourceId);
    await mkdir(packet, {recursive: true});
    await writeFile(join(packet, 'extracted.md'), '共同关键词 ' + title);
    await writeFile(join(packet, 'manifest.json'), JSON.stringify({id: sourceId, title}));
  }
  const handle = createKbMcp({
    vaultRoot: root, accounts: {get: () => account}, secret,
    documentGrants: new Map([[id, await granted(root, id, {kind: 'viral-script', level: 'opening'})]]),
    authorize: token => token === 'read-session' ? {account, mode: 'read'} : null,
  });
  const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'search', arguments: {query: '共同关键词'}}});
  const response = await handle({method: 'POST', headers: {authorization: 'Bearer read-session'}, body});
  assert.equal(response.status, 200);
  const result = JSON.parse(response.body).result.content[0].text;
  assert.match(result, /SRC-2026-09-28-001/);
  assert.match(result, /类型: source/);
  assert.doesNotMatch(result, /私人剧本|SRC-2026-09-28-002/);
  const none = createKbMcp({vaultRoot: root, accounts: {get: () => account}, secret, authorize: token => token === 'read-session' ? {account, mode: 'read'} : null});
  const empty = await none({method: 'POST', headers: {authorization: 'Bearer read-session'}, body});
  assert.match(JSON.parse(empty.body).result.content[0].text, /已扫描 0 篇/);
  assert.doesNotMatch(JSON.parse(empty.body).result.content[0].text, /私人剧本|获授权样本/);
});

test('read pages through granted source and wiki IDs without exposing ungranted documents or paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-read-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const packet = join(root, 'raw', 'sources', id);
  await mkdir(packet, {recursive: true});
  await writeFile(join(packet, 'extracted.md'), '起'.repeat(6000) + '首个悬念' + '尾'.repeat(7000));
  await writeFile(join(packet, 'manifest.json'), JSON.stringify({id, title: '来源剧本'}));
  const ordinaryId = 'SRC-2026-09-28-003';
  const ordinaryPacket = join(root, 'raw', 'sources', ordinaryId);
  await mkdir(ordinaryPacket, {recursive: true});
  await writeFile(join(ordinaryPacket, 'extracted.md'), '普通资料开头');
  await writeFile(join(ordinaryPacket, 'manifest.json'), JSON.stringify({id: ordinaryId, title: '普通资料'}));
  const wikiId = 'wiki/剧本/节奏复盘';
  await mkdir(join(root, 'wiki', '剧本'), {recursive: true});
  await writeFile(join(root, 'wiki', '剧本', '节奏复盘.md'), '# 节奏复盘\n开场冲突来自身份错位。');
  const handle = createKbMcp({
    vaultRoot: root, accounts: {get: () => account}, secret,
    documentGrants: new Map([[id, await granted(root, id, {kind: 'viral-script'})], [wikiId, await granted(root, wikiId)], [ordinaryId, await granted(root, ordinaryId)]]),
  });
  const call = async (name, args) => {
    const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}});
    const response = await handle({method: 'POST', headers: {authorization: `Bearer ${kbToken(secret, account.id, account.revision)}`}, body});
    return JSON.parse(response.body).result;
  };
  const source = await call('read', {id, start: 6000});
  assert.match(source.content[0].text, /首个悬念/);
  assert.match(source.content[0].text, /已读字符范围: \[6000, 12000\)/);
  assert.match(source.content[0].text, /正文页码: 2/);
  assert.match(source.content[0].text, /类型: source/);
  const wiki = await call('read', {id: wikiId});
  assert.match(wiki.content[0].text, /开场冲突来自身份错位/);
  assert.match(wiki.content[0].text, /类型: wiki/);
  assert.match((await call('read', {id: ordinaryId})).content[0].text, /普通资料开头/);
  assert.equal((await call('read_opening', {id: wikiId})).isError, true);
  assert.equal((await call('read_opening', {id: ordinaryId})).isError, true);
  assert.match((await call('read_opening', {id})).content[0].text, /起/);
  assert.equal((await call('read', {id: 'wiki/../secret'})).isError, true);
  assert.equal((await call('read', {id: 'SRC-2026-09-28-099'})).isError, true);
  assert.equal((await call('read', {id, start: 999999})).isError, true);
});

test('grant file explicitly binds source and wiki IDs to opening or full-read access', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-grants-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = join(root, 'grants.json');
  const wikiId = 'wiki/剧本/节奏复盘';
  const sourceHash = 'a'.repeat(64), wikiHash = 'b'.repeat(64);
  await writeFile(file, JSON.stringify({version: 1, grants: [
    {id, kind: 'viral-script', level: 'opening', access: 'all-authenticated', sha256: sourceHash, title: 'Admin title'},
    {id: wikiId, kind: 'knowledge', level: 'read', access: 'accounts', accountIds: [account.id], sha256: wikiHash},
  ]}));
  const grants = await loadDocumentGrants(file);
  assert.deepEqual(grants.get(id), {kind: 'viral-script', level: 'opening', accounts: new Set(['*']), sha256: sourceHash, title: 'Admin title'});
  assert.deepEqual(grants.get(wikiId), {kind: 'knowledge', level: 'read', accounts: new Set([account.id]), sha256: wikiHash});
  await writeFile(file, JSON.stringify({version: 1, grants: [{id, kind: 'viral-script', level: 'opening', access: 'all-authenticated'}]}));
  await assert.rejects(loadDocumentGrants(file), /Invalid document grant/);
  await writeFile(file, JSON.stringify({version: 1, grants: [{id, kind: 'viral-script', level: 'opening', access: 'all-authenticated', sha256: 'A'.repeat(64)}]}));
  await assert.rejects(loadDocumentGrants(file), /Invalid document grant/);
  await writeFile(file, JSON.stringify({version: 1, grants: [{id, kind: 'viral-script', level: 'opening', access: 'all-authenticated', sha256: sourceHash, title: ' '}]}));
  await assert.rejects(loadDocumentGrants(file), /Invalid document grant/);
  await writeFile(file, JSON.stringify({version: 1, grants: [{id: 'wiki/../outside', kind: 'knowledge', level: 'read', access: 'all-authenticated'}]}));
  await assert.rejects(loadDocumentGrants(file), /Invalid document grant/);
  await writeFile(file, JSON.stringify({version: 1, grants: [{id, kind: 'viral-script', level: 'read', access: 'accounts', accountIds: ['another-user']}]}));
  await assert.rejects(loadDocumentGrants(file), /Invalid document grant/);
  await writeFile(file, JSON.stringify({version: 1, grants: [{id, level: 'opening', access: 'all-authenticated'}]}));
  await assert.rejects(loadDocumentGrants(file), /Invalid document grant/);
  await writeFile(file, JSON.stringify({version: 1, grants: [{id: wikiId, kind: 'viral-script', level: 'read', access: 'all-authenticated'}]}));
  await assert.rejects(loadDocumentGrants(file), /Invalid document grant/);
});

test('opening-only search cannot find a script by text after the opening limit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-tail-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const packet = join(root, 'raw', 'sources', id);
  await mkdir(packet, {recursive: true});
  await writeFile(join(packet, 'extracted.md'), '开场'.repeat(12_000) + 'XYZUNSEENTAILMARKER');
  await writeFile(join(packet, 'manifest.json'), JSON.stringify({id, title: '保密后文'}));
  const handle = createKbMcp({
    vaultRoot: root, accounts: {get: () => account}, secret,
    documentGrants: new Map([[id, await granted(root, id, {kind: 'viral-script', level: 'opening'})]]), semanticFloor: 0,
    authorize: token => token === 'read-session' ? {account, mode: 'read'} : null,
  });
  const query = async word => {
    const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'search', arguments: {query: word}}});
    const response = await handle({method: 'POST', headers: {authorization: 'Bearer read-session'}, body});
    return JSON.parse(response.body).result.content[0].text;
  };
  assert.match(await query('开场'), /id: SRC-2026-09-28-001/);
  const tail = await query('XYZUNSEENTAILMARKER');
  assert.doesNotMatch(tail, /id:|保密后文|XYZUNSEENTAILMARKER.*摘要/);
});

test('opening grants hide later titles, vectors, and full text for session and legacy tokens', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-metadata-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const packet = join(root, 'raw', 'sources', id);
  await mkdir(packet, {recursive: true});
  await writeFile(join(packet, 'extracted.md'), 'OPENING '.repeat(3000) + '\n---\ntitle: TAIL_SECRET\nTAIL_SECRET');
  await writeFile(join(packet, 'manifest.json'), JSON.stringify({id, title: 'MANIFEST_SECRET'}));
  const handle = createKbMcp({
    vaultRoot: root, accounts: {get: () => account}, secret,
    documentGrants: new Map([[id, await granted(root, id, {kind: 'viral-script', level: 'opening'})]]),
    authorize: token => token === 'read-session' ? {account, mode: 'read'} : null,
    embedder: {enabled: true, model: 'test', embed: async () => [1]},
    vectors: {refresh() {}, get() {return [1];}, size() {return 999;}},
  });
  const call = async (token, name, args = {}) => {
    const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}});
    const response = await handle({method: 'POST', headers: {authorization: `Bearer ${token}`}, body});
    assert.equal(response.status, 200);
    return JSON.parse(response.body).result;
  };
  for (const token of ['read-session', kbToken(secret, account.id, account.revision)]) {
    const opening = (await call(token, 'search', {query: 'OPENING'})).content[0].text;
    assert.match(opening, /id: SRC-2026-09-28-001/);
    assert.doesNotMatch(opening, /MANIFEST_SECRET|TAIL_SECRET/);
    for (const query of ['MANIFEST_SECRET', 'TAIL_SECRET']) {
      assert.doesNotMatch((await call(token, 'search', {query})).content[0].text, /id: SRC-2026-09-28-001/);
    }
    const page = (await call(token, 'read_opening', {id})).content[0].text;
    assert.doesNotMatch(page, /MANIFEST_SECRET|TAIL_SECRET/);
    assert.equal((await call(token, 'read', {id})).isError, true);
    assert.doesNotMatch((await call(token, 'status')).content[0].text, /999/);
  }
});

test('changed source bytes invalidate read, opening, search, and status without leaking a manifest title', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-digest-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const packet = join(root, 'raw', 'sources', id);
  await mkdir(packet, {recursive: true});
  await writeFile(join(packet, 'extracted.md'), 'GRANTED_OPENING');
  await writeFile(join(packet, 'manifest.json'), JSON.stringify({id, title: 'UNTRUSTED_MANIFEST_TITLE'}));
  const sourceGrant = await granted(root, id, {kind: 'viral-script', title: 'ADMIN_TITLE'});
  const handle = createKbMcp({vaultRoot: root, accounts: {get: () => account}, secret, documentGrants: new Map([[id, sourceGrant]])});
  assert.match((await invoke(handle, 'read', {id})).content[0].text, /GRANTED_OPENING|ADMIN_TITLE/);
  assert.match((await invoke(handle, 'read_opening', {id})).content[0].text, /GRANTED_OPENING/);
  assert.match((await invoke(handle, 'search', {query: 'GRANTED_OPENING'})).content[0].text, /ADMIN_TITLE/);
  assert.doesNotMatch((await invoke(handle, 'search', {query: 'GRANTED_OPENING'})).content[0].text, /UNTRUSTED_MANIFEST_TITLE/);
  await writeFile(join(packet, 'extracted.md'), 'CHANGED_SECRET');
  for (const name of ['read', 'read_opening']) {
    const result = await invoke(handle, name, {id});
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, /CHANGED_SECRET|UNTRUSTED_MANIFEST_TITLE|ADMIN_TITLE/);
  }
  const search = (await invoke(handle, 'search', {query: 'CHANGED_SECRET'})).content[0].text;
  assert.doesNotMatch(search, /id:|UNTRUSTED_MANIFEST_TITLE|ADMIN_TITLE/);
  assert.match(search, /0/);
  const status = (await invoke(handle, 'status')).content[0].text;
  assert.doesNotMatch(status, /\b1\b|CHANGED_SECRET|UNTRUSTED_MANIFEST_TITLE|ADMIN_TITLE/);
});

test('search and status ignore configured vectors and remain available offline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-vector-error-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const hiddenPath = join(root, 'private', 'vectors.json');
  const warnings = [];
  const handle = createKbMcp({
    vaultRoot: root, accounts: {get: () => account}, secret,
    embedder: {enabled: true, model: 'test', embed: async () => [1]},
    vectors: {refresh() {throw new Error(`Cannot read ${hiddenPath}`);}},
    onWarn: message => warnings.push(message),
  });
  for (const name of ['search', 'status']) {
    const result = await invoke(handle, name, name === 'search' ? {query: 'opening'} : {});
    assert.equal(result.isError, undefined);
    assert.doesNotMatch(result.content[0].text, /vectors\.json|private|Cannot read/);
  }
  assert.equal(warnings.length, 0);
});

test('search hashes all source bytes before indexing its first 400000 characters', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-full-hash-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const packet = join(root, 'raw', 'sources', id);
  await mkdir(packet, {recursive: true});
  const path = join(packet, 'extracted.md');
  await writeFile(path, 'FIND_GRANTED ' + 'x'.repeat(400_000) + 'ORIGINAL_TAIL');
  const sourceGrant = await granted(root, id, {kind: 'viral-script'});
  const handle = createKbMcp({vaultRoot: root, accounts: {get: () => account}, secret, documentGrants: new Map([[id, sourceGrant]])});
  assert.match((await invoke(handle, 'search', {query: 'FIND_GRANTED'})).content[0].text, /id: SRC-2026-09-28-001/);
  await writeFile(path, 'FIND_GRANTED ' + 'x'.repeat(400_000) + 'MUTATED_TAIL');
  assert.doesNotMatch((await invoke(handle, 'search', {query: 'FIND_GRANTED'})).content[0].text, /id: SRC-2026-09-28-001/);
});

test('a symlinked source parent only reads the granted bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-link-parent-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const parent = join(root, 'raw', 'sources', id);
  const approved = join(root, 'approved');
  await mkdir(parent, {recursive: true});
  await mkdir(approved);
  await writeFile(join(parent, 'extracted.md'), 'APPROVED_BODY');
  await writeFile(join(approved, 'extracted.md'), 'APPROVED_BODY');
  const sourceGrant = await granted(root, id, {kind: 'viral-script'});
  await rename(parent, join(root, 'old-packet'));
  await symlink(approved, parent, process.platform === 'win32' ? 'junction' : 'dir');
  const handle = createKbMcp({vaultRoot: root, accounts: {get: () => account}, secret, documentGrants: new Map([[id, sourceGrant]])});
  assert.match((await invoke(handle, 'read', {id})).content[0].text, /APPROVED_BODY/);
  await writeFile(join(approved, 'extracted.md'), 'OTHER_SECRET');
  const result = await invoke(handle, 'read', {id});
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /OTHER_SECRET/);
  assert.doesNotMatch((await invoke(handle, 'search', {query: 'OTHER_SECRET'})).content[0].text, /id: SRC-2026-09-28-001|OTHER_SECRET.*摘要/);
});
