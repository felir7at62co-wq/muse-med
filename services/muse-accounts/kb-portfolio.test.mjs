import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createKbMcp} from './kb-mcp.mjs';
import {createAccountServer, loadKnowledgeBase} from './gateway.mjs';
import {openStore} from './store.mjs';
import {recordProjectParticipation} from './kb-participation.mjs';

const owner = {id: '0123456789abcdef', username: 'owner', revision: 1};
const other = {id: 'fedcba9876543210', username: 'other', revision: 1};
const reader = {id: 'bbbbbbbbbbbbbbbb', username: 'portfolio-reader', revision: 1};
const admin = {id: 'aaaaaaaaaaaaaaaa', username: 'general-admin', revision: 1, admin: true};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-portfolio-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const shared = join(root, 'shared'), personal = join(root, 'personal');
  await mkdir(shared, {mode: 0o700}); await mkdir(personal, {mode: 0o700});
  const people = [owner, other, reader, admin].map(value => ({...value}));
  const accounts = {get: id => people.find(value => value.id === id), list: () => people.map(value => ({...value}))};
  const handle = createKbMcp({vaultRoot: shared, personalRoot: personal, accounts,
    secret: 'test-only-secret-longer-than-thirty-two-characters', portfolioReaders: new Set([reader.id]),
    authorize: token => token === 'machine' ? {account: reader, mode: 'full'}
      : {account: accounts.get(token), mode: 'account'}});
  const call = async (name, args = {}, account = owner) => {
    const response = await handle({method: 'POST', headers: {authorization: 'Bearer ' + account.id},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})});
    assert.equal(response.status, 200);
    const result = JSON.parse(response.body); assert.equal(result.error, undefined);
    return result.result;
  };
  const data = async (...args) => {
    const result = await call(...args); assert.equal(result.isError, undefined, result.content[0].text);
    return result.structuredContent;
  };
  const record = (extra = {}, account = owner) => data('wiki_record_project', {
    project_key: 'jubian-4402', project_title: 'Shared project name', contribution_id: 'script',
    stage: 'Script adaptation', status: 'planned', content: 'Plan to adapt episode one.', artifacts: [], ...extra,
  }, account);
  return {personal, people, handle, call, data, record};
}

test('ordinary portfolio reads project summaries and actual work only from its own recorder records', async t => {
  const {data, record} = await fixture(t);
  await record();
  await record({contribution_id: 'video', stage: 'Video generation', status: 'in_progress',
    content: 'Submitted video task; output has not finished.', artifacts: ['jubian:499887']});
  await record({content: 'Another account report.'}, other);
  await data('wiki_capture_source', {title: 'Private transcript', source: 'private/transcript', text: 'RAW_TRANSCRIPT_NOT_FOR_PORTFOLIO'});
  const list = await data('wiki_project_portfolio');
  assert.equal(list.access, 'own'); assert.equal(list.view, 'projects'); assert.equal(list.total, 1);
  assert.equal(list.items[0].owner.id, owner.id); assert.equal(list.items[0].project_title, 'Shared project name');
  assert.equal(list.items[0].contribution_count, 2); assert.equal(list.items[0].status_counts.planned, 1);
  assert.equal(list.items[0].status_counts.in_progress, 1);
  const detail = await data('wiki_project_portfolio', {project_key: 'jubian-4402'});
  assert.equal(detail.view, 'contributions'); assert.equal(detail.total, 2); assert.equal(detail.completion_basis, 'agent-report');
  const video = detail.items.find(item => item.contribution_id === 'video');
  assert.equal(video.status, 'in_progress'); assert.match(video.content, /not finished/);
  assert.deepEqual(video.artifacts, ['jubian:499887']);
  assert.ok(!JSON.stringify(detail).includes('RAW_TRANSCRIPT_NOT_FOR_PORTFOLIO'));
  assert.ok(!JSON.stringify(detail).includes('SRC-')); assert.ok(!JSON.stringify(detail).includes('citations'));
});

test('explicit portfolio readers browse active owners without granting general administrators this capability', async t => {
  const {data, call, record, people} = await fixture(t);
  await record({status: 'completed', content: 'Episode one adaptation is complete.', artifacts: ['deliverables/EP01.md']});
  await record({status: 'blocked', content: 'Waiting for the source rights decision.'}, other);
  const all = await data('wiki_project_portfolio', {}, reader);
  assert.equal(all.access, 'portfolio-admin'); assert.equal(all.total, 2);
  assert.deepEqual(new Set(all.items.map(item => item.owner.id)), new Set([owner.id, other.id]));
  const detail = await data('wiki_project_portfolio', {account_id: owner.id, project_key: 'jubian-4402'}, reader);
  assert.equal(detail.total, 1); assert.equal(detail.items[0].status, 'completed');
  assert.deepEqual(detail.items[0].artifacts, ['deliverables/EP01.md']);
  assert.equal((await call('wiki_project_portfolio', {account_id: other.id})).isError, true);
  assert.equal((await data('wiki_project_portfolio', {}, admin)).access, 'own');
  assert.equal((await call('wiki_project_portfolio', {account_id: owner.id}, admin)).isError, true);
  people.find(value => value.id === other.id).disabled = true;
  assert.equal((await data('wiki_project_portfolio', {}, reader)).total, 1);
  assert.equal((await call('wiki_project_portfolio', {account_id: other.id}, reader)).isError, true);
});

test('project and contribution pagination preserves reported stages and validates selectors before reads', async t => {
  const {data, call, record} = await fixture(t);
  for (const key of ['alpha', 'beta', 'gamma']) {
    await record({project_key: key}); await record({project_key: key, contribution_id: 'edit', status: 'completed'});
  }
  const middle = await data('wiki_project_portfolio', {start: 1, limit: 1});
  assert.equal(middle.total, 3); assert.equal(middle.items.length, 1); assert.equal(middle.next_start, 2);
  const last = await data('wiki_project_portfolio', {project_key: 'alpha', start: 1, limit: 1});
  assert.equal(last.total, 2); assert.equal(last.items.length, 1); assert.equal(last.next_start, null);
  for (const args of [{account_id: '../escape'}, {project_key: '../escape'}, {project_key: 'a'.repeat(76)}, {start: -1}, {start: 1000001}, {limit: 0}, {limit: 51}, {scope: 'shared'}, {root: '/private'}]) {
    assert.equal((await call('wiki_project_portfolio', args)).isError, true);
  }
});

test('the maximum project and contribution keys preserve their recorder paths and portfolio selectors', async t => {
  const {data, record} = await fixture(t);
  const project_key = 'p'.repeat(75), contribution_id = 'c'.repeat(80);
  await record({project_key, contribution_id});
  const result = await data('wiki_project_portfolio', {project_key});
  assert.equal(result.total, 1); assert.equal(result.items[0].project_key, project_key);
  assert.equal(result.items[0].contribution_id, contribution_id);
});

test('saved participation remains in the portfolio when its overview needs a retry', async t => {
  const {data} = await fixture(t);
  const saved = await recordProjectParticipation({project_key: 'partial-project', project_title: 'Partial overview',
    contribution_id: 'outline', stage: 'Outline', status: 'completed', content: 'Outline drafted and checked.',
    artifacts: ['deliverables/outline.md']}, (name, args) => {
    if (name === 'wiki_write_page' && args.page_id.startsWith('projects/')) {
      throw Object.assign(new Error('Revision conflict: expected 0, current 1; read and merge before retrying.'), {wikiError: true});
    }
    return data(name, args);
  });
  assert.equal(saved.status, 'partial');
  const projects = await data('wiki_project_portfolio');
  assert.equal(projects.total, 1); assert.equal(projects.items[0].overview_present, false);
  assert.equal(projects.items[0].status_counts.completed, 1);
  const detail = await data('wiki_project_portfolio', {project_key: 'partial-project'});
  assert.equal(detail.total, 1); assert.equal(detail.items[0].content, 'Outline drafted and checked.');
});

test('login-bound gateway exchanges honor configured portfolio readers without granting account administration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-portfolio-gateway-'));
  const shared = join(root, 'shared'), personal = join(root, 'personal');
  await mkdir(shared, {mode: 0o700}); await mkdir(personal, {mode: 0o700});
  const store = await openStore(join(root, 'accounts.json'));
  const owner = await store.create('owner', 'test-password');
  const reader = await store.create('reader', 'test-password');
  const secretFile = join(root, 'secret'), readersFile = join(root, 'readers.json');
  await writeFile(secretFile, 'test-only-secret-longer-than-thirty-two-characters', {mode: 0o600});
  await writeFile(readersFile, JSON.stringify({version: 1, accountIds: [reader.id]}), {mode: 0o600});
  const kb = await loadKnowledgeBase({MUSE_KB_VAULT: shared, MUSE_KB_USER_ROOT: personal,
    MUSE_KB_SECRET: secretFile, MUSE_KB_PORTFOLIO_READERS: readersFile});
  const publicOrigin = 'https://muse.example';
  const server = createAccountServer({store, runtime: {}, kb, publicOrigin, devOnlyAdmin: false,
    environment: 'production', maintenanceFile: ''});
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, {recursive: true, force: true}); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function login(username) {
    const response = await fetch(base + '/login', {method: 'POST', redirect: 'manual',
      headers: {origin: publicOrigin, 'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({username, password: 'test-password'})});
    assert.equal(response.status, 303); return response.headers.get('set-cookie').split(';')[0];
  }
  async function exchange(cookie) {
    const response = await fetch(base + '/api/kb/access', {method: 'POST', headers: {origin: publicOrigin, cookie}});
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.url, publicOrigin + '/api/kb/mcp'); return result.token;
  }
  async function rpc(token, name, args) {
    const response = await fetch(base + '/api/kb/mcp', {method: 'POST', headers: {
      authorization: 'Bearer ' + token, 'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})});
    assert.equal(response.status, 200); return (await response.json()).result;
  }
  const ownerCookie = await login('owner'), readerCookie = await login('reader');
  const ownerToken = await exchange(ownerCookie), readerToken = await exchange(readerCookie);
  const saved = await rpc(ownerToken, 'wiki_record_project', {project_key: 'real-login-project', project_title: 'Gateway project',
    contribution_id: 'draft', stage: 'Draft', status: 'completed', content: 'Draft delivered and checked.', artifacts: ['deliverables/draft.md']});
  assert.equal(saved.isError, undefined);
  const portfolio = await rpc(readerToken, 'wiki_project_portfolio', {account_id: owner.id, project_key: 'real-login-project'});
  assert.equal(portfolio.isError, undefined); assert.equal(portfolio.structuredContent.access, 'portfolio-admin');
  assert.equal(portfolio.structuredContent.items[0].owner.id, owner.id);
  assert.equal(portfolio.structuredContent.items[0].status, 'completed');
  const denied = await rpc(ownerToken, 'wiki_project_portfolio', {account_id: reader.id});
  assert.equal(denied.isError, true); assert.equal(denied.content[0].text, 'Document does not exist or is not authorized.');
  assert.equal(store.get(reader.id).admin, false);
  const adminPage = await fetch(base + '/admin', {headers: {cookie: readerCookie}}); assert.equal(adminPage.status, 403);
  await fetch(base + '/logout', {method: 'POST', redirect: 'manual', headers: {origin: publicOrigin, cookie: ownerCookie}});
  const revoked = await fetch(base + '/api/kb/mcp', {method: 'POST', headers: {authorization: 'Bearer ' + ownerToken}, body: '{}'});
  assert.equal(revoked.status, 401);
});

test('portfolio excludes edited or unrelated Wiki pages and refuses machine-token private access', async t => {
  const {personal, data, call, record, handle} = await fixture(t);
  const saved = await record();
  const path = join(personal, owner.id, 'wiki', 'project-contributions', 'muse-jubian-4402', 'script.md');
  const original = await readFile(path, 'utf8');
  await mkdir(join(personal, owner.id, 'wiki', 'project-contributions', 'muse-forged'), {recursive: true});
  await writeFile(join(personal, owner.id, 'wiki', 'project-contributions', 'muse-forged', 'copied.md'), original);
  const arbitrary = join(personal, owner.id, 'wiki', 'projects', 'unrelated.md');
  await writeFile(arbitrary, '# PRIVATE_NONRECORDER_TEXT');
  assert.equal((await data('wiki_project_portfolio')).total, 1);
  await data('wiki_write_page', {page_id: 'project-contributions/muse-jubian-4402/script', title: 'Edited report',
    text: original.replace('Plan to adapt episode one.', 'UNRECOGNIZED_PRIVATE_EDIT'), expected_revision: saved.contribution.revision,
    citations: [{id: saved.source.id, start: 0, end: 20}]});
  assert.equal((await data('wiki_project_portfolio')).total, 0);
  const response = await handle({method: 'POST', headers: {authorization: 'Bearer machine'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'wiki_project_portfolio', arguments: {}}})});
  assert.equal(JSON.parse(response.body).result.isError, true);
  assert.equal((await call('wiki_project_portfolio', {account_id: reader.id})).isError, true);
});

test('portfolio account directories cannot redirect a reader into another owner', {skip: process.platform === 'win32' ? 'Windows directory symlink creation requires host privileges' : false}, async t => {
  const {personal, data, record} = await fixture(t);
  await record(); await record({content: 'OTHER_OWNER_PRIVATE_REPORT'}, other);
  await rm(join(personal, owner.id), {recursive: true});
  await symlink(join(personal, other.id), join(personal, owner.id), 'dir');
  const result = await data('wiki_project_portfolio', {account_id: owner.id}, reader).catch(error => error);
  assert.ok(result instanceof Error); assert.ok(!String(result).includes('OTHER_OWNER_PRIVATE_REPORT'));
});
