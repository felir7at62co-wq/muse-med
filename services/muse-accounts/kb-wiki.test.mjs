import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createKbMcp} from './kb-mcp.mjs';

const owner = {id: '0123456789abcdef', username: 'owner', revision: 1, disabled: false};
const other = {id: 'fedcba9876543210', username: 'other', revision: 1, disabled: false};
const admin = {id: 'aaaaaaaaaaaaaaaa', username: 'admin', admin: true, revision: 1, disabled: false};
const sha = text => createHash('sha256').update(text).digest('hex');

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-wiki-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const shared = join(root, 'shared'), personal = join(root, 'personal');
  await mkdir(shared, {mode: 0o700});
  await mkdir(personal, {mode: 0o700});
  const accounts = {get: id => [owner, other, admin].find(item => item.id === id)};
  const handle = createKbMcp({vaultRoot: shared, personalRoot: personal, accounts,
    secret: 'test-only-secret-longer-than-thirty-two-characters',
    authorize: token => token === 'owner' ? {account: owner, mode: 'account'}
      : token === 'other' ? {account: other, mode: 'account'}
      : token === 'admin' ? {account: admin, mode: 'account'}
      : token === 'machine' ? {account: owner, mode: 'full'}
      : token === 'admin-machine' ? {account: admin, mode: 'full'} : null, ...options});
  const rpc = async (method, params, token = 'owner') => {
    const response = await handle({method: 'POST', headers: {authorization: `Bearer ${token}`},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
    assert.equal(response.status, 200);
    return JSON.parse(response.body);
  };
  const call = async (name, args = {}, token = 'owner') => {
    const response = await rpc('tools/call', {name, arguments: args}, token);
    assert.equal(response.error, undefined, response.error?.message);
    return response.result;
  };
  const data = async (name, args = {}, token = 'owner') => {
    const result = await call(name, args, token);
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  };
  return {root, shared, personal, rpc, call, data};
}

const capture = (data, extra = {}) => data('wiki_capture_source', {
  title: 'Case notes', text: 'Opening hook: the vanished mother returns. EVIDENCE_MARKER.',
  source: 'project/episode-01', ...extra,
});
const page = (source, extra = {}) => ({
  page_id: 'concepts/opening-hook', title: 'Opening hook',
  text: `# Opening hook\n\nThe mother returns. [[sources/${source.id.split('/').at(-1)}]]`,
  citations: [{id: source.id, start: 0, end: 40}], expected_revision: 0, ...extra,
});

const participation = extra => ({project_key: 'jubian-4402', project_title: '山河闻凤鸣',
  contribution_id: 'episode-02-script', stage: '第二集剧本', status: 'planned',
  content: '计划根据原稿完成第二集改编。', artifacts: [], ...extra});

test('project participation records plans, actual work, and private browsable projects without duplicate revisions', async t => {
  const {data} = await fixture(t);
  const planned = await data('wiki_record_project', participation());
  assert.equal(planned.status, 'synced');
  const duplicate = await data('wiki_record_project', participation());
  assert.equal(duplicate.contribution.revision, planned.contribution.revision);
  const done = await data('wiki_record_project', participation({status: 'completed',
    content: '已逐场核对原稿，完成第二集剧本。', artifacts: ['deliverables/EP02.md']}));
  assert.equal(done.contribution.revision, planned.contribution.revision + 1);
  assert.equal(done.recorded_status, 'completed');
  const detail = await data('wiki_read', {scope: 'private', id: done.contribution.id});
  assert.match(detail.body, /逐场核对原稿/);
  assert.match(detail.body, /deliverables\/EP02.md/);
  const list = await data('wiki_directory', {scope: 'private', folder: 'projects'});
  assert.equal(list.total, 1);
  assert.equal(list.items[0].title, '山河闻凤鸣');
  assert.equal((await data('wiki_directory', {scope: 'private', folder: 'projects'}, 'other')).total, 0);
  const isolated = await data('wiki_record_project', participation({content: '另一账号的同名项目'}), 'other');
  assert.notEqual(isolated.source.sha256, done.source.sha256);
  assert.match((await data('wiki_read', {scope: 'private', id: done.contribution.id})).body, /逐场核对原稿/);
});

test('project participation preserves independent milestones and keeps pending work distinct from completion', async t => {
  const {data} = await fixture(t);
  await data('wiki_record_project', participation());
  const pending = await data('wiki_record_project', participation({contribution_id: 'episode-02-video',
    stage: '第二集视频', status: 'in_progress', content: '视频任务已提交，仍在等待远端生成。', artifacts: ['jubian:499887']}));
  assert.equal(pending.recorded_status, 'in_progress');
  const overview = await data('wiki_read', {scope: 'private', id: pending.project.id});
  assert.match(overview.body, /第二集剧本/);
  assert.match(overview.body, /第二集视频/);
  assert.match(overview.body, /进行中/);
});

test('project participation rejects shared scope, unstable keys, and credential-bearing artifact URLs before capture', async t => {
  const {call, data} = await fixture(t);
  for (const invalid of [{scope: 'shared'}, {project_key: '../escape'}, {artifacts: ['https://host/file?token=secret']}]) {
    const result = await call('wiki_record_project', participation(invalid));
    assert.equal(result.isError, true);
  }
  assert.equal((await data('wiki_status')).private.sources, 0);
});

test('project participation reports a saved contribution separately from an unsynchronized human overview', async t => {
  const {personal, data} = await fixture(t);
  const overview = join(personal, owner.id, 'wiki', 'projects', 'muse-jubian-4402.md');
  await mkdir(join(personal, owner.id, 'wiki', 'projects'), {recursive: true});
  const human = '# Human project notes\n\nPreserve this page.\n';
  await writeFile(overview, human);
  const result = await data('wiki_record_project', participation());
  assert.equal(result.status, 'partial');
  assert.equal(result.verified_readback, undefined);
  assert.equal(result.project.sync, 'retry-required');
  assert.equal(await readFile(overview, 'utf8'), human);
  assert.match((await data('wiki_read', {id: result.contribution.id})).body, /计划根据原稿完成第二集改编/);
  const duplicate = await data('wiki_record_project', participation());
  assert.equal(duplicate.contribution.revision, result.contribution.revision);
});

test('project participation preserves contribution pages edited outside the recorder', async t => {
  const {data, call} = await fixture(t);
  const initial = await data('wiki_record_project', participation());
  const current = await data('wiki_read', {id: initial.contribution.id});
  const edited = current.body + '\nHuman amendment.\n';
  await data('wiki_write_page', {page_id: 'project-contributions/muse-jubian-4402/episode-02-script',
    title: current.title, text: edited, expected_revision: current.revision,
    citations: current.citations.map(({id, start, end}) => ({id, start, end}))});
  const result = await call('wiki_record_project', participation({status: 'completed'}));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /edited outside the recorder/);
  assert.equal((await data('wiki_read', {id: initial.contribution.id})).body, edited);
  assert.equal(initial.recorded_status, 'planned');
});

test('project participation accepts the longest project segment and refuses longer keys before capturing', async t => {
  const {data, call} = await fixture(t);
  const result = await data('wiki_record_project', participation({project_key: 'p'.repeat(75), contribution_id: 's'.repeat(80)}));
  assert.equal(result.status, 'synced');
  const before = (await data('wiki_status')).private.sources;
  assert.equal((await call('wiki_record_project', participation({project_key: 'p'.repeat(76)}))).isError, true);
  assert.equal((await data('wiki_status')).private.sources, before);
});

test('MCP lists Wiki navigation and synthesis with no embedding requirement', async t => {
  const {rpc} = await fixture(t);
  const tools = (await rpc('tools/list', {})).result.tools;
  for (const name of ['wiki_capture_source', 'wiki_directory', 'wiki_search', 'wiki_read',
    'wiki_write_page', 'wiki_history', 'wiki_links', 'wiki_status', 'wiki_migration_preview']) {
    assert.ok(tools.some(tool => tool.name === name), name);
  }
  assert.ok(!tools.some(tool => /embed|vector/.test(tool.name)));
});

test('captured originals remain immutable while linked pages keep revisions and exact citations', async t => {
  const {personal, data, call} = await fixture(t);
  const first = await capture(data);
  assert.match(first.source.id, /^private\/SRC-/);
  assert.equal(first.page.status, 'skeleton');
  const original = join(personal, owner.id, 'raw', 'sources', first.source.id.slice(8), 'extracted.md');
  const before = await readFile(original, 'utf8');
  const written = await data('wiki_write_page', page(first.source));
  assert.equal(written.revision, 1);
  assert.match((await call('read', {id: written.id})).content[0].text, /mother returns/);
  const read = await data('wiki_read', {id: written.id});
  assert.match(read.body, /vanished mother|mother returns/);
  assert.equal(read.citations[0].sha256, sha(before));
  assert.equal(read.citations[0].excerpt, Array.from(before).slice(0, 40).join(''));
  const updated = await data('wiki_write_page', page(first.source, {expected_revision: 1, text: '# Opening hook\n\nA revised analysis.'}));
  assert.equal(updated.revision, 2);
  assert.equal((await call('wiki_write_page', page(first.source, {expected_revision: 1}))).isError, true);
  const history = await data('wiki_history', {id: written.id});
  assert.deepEqual(history.revisions.map(item => item.revision), [2, 1]);
  const previous = await data('wiki_read', {id: written.id, revision: 1});
  assert.match(previous.body, /mother returns/);
  assert.equal(await readFile(original, 'utf8'), before);
  const duplicate = await capture(data);
  assert.equal(duplicate.source.id, first.source.id);
  assert.equal(duplicate.duplicate, true);
});

test('private and project directories, fulltext matches, and backlinks remain account scoped', async t => {
  const {data, call} = await fixture(t);
  const personal = await capture(data);
  const privatePage = await data('wiki_write_page', page(personal.source));
  const project = await capture(data, {scope: 'project', project_id: 'drama-one', text: 'PROJECT_ONLY_MARKER scene one.'});
  const projectPage = await data('wiki_write_page', page(project.source, {
    scope: 'project', project_id: 'drama-one', citations: [{id: project.source.id, start: 0, end: 20}],
    text: '# Hook\n\nPROJECT_ONLY_MARKER [[sources/' + project.source.id.split('/').at(-1) + ']]',
  }));
  const projectSearch = await data('wiki_search', {scope: 'project', project_id: 'drama-one', query: 'PROJECT_ONLY_MARKER'});
  assert.ok(projectSearch.results.some(item => item.id === projectPage.id));
  const ownDirectory = await data('wiki_directory');
  assert.ok(ownDirectory.items.some(item => item.id === privatePage.id));
  assert.ok(!ownDirectory.items.some(item => item.id === projectPage.id));
  assert.equal((await call('wiki_read', {id: privatePage.id}, 'other')).isError, true);
  assert.equal((await call('wiki_read', {scope: 'project', project_id: 'drama-one', id: projectPage.id}, 'other')).isError, true);
  const otherSearch = await data('wiki_search', {scope: 'project', project_id: 'drama-one', query: 'PROJECT_ONLY_MARKER'}, 'other');
  assert.equal(otherSearch.results.length, 0);
  const links = await data('wiki_links', {id: personal.page.id});
  assert.ok(links.backlinks.some(item => item.id === privatePage.id));
  const status = await data('wiki_status');
  assert.equal(status.retrieval, 'directory-fulltext-links');
  assert.equal(status.configured, true);
  assert.equal(status.private.sources, 1);
  assert.equal(status.shared.grants, 0);
});

test('Wiki writes reject invalid citations, source edits, root overrides, and path traversal', async t => {
  const {data, call} = await fixture(t);
  const first = await capture(data);
  for (const args of [
    page(first.source, {page_id: '../escape'}),
    page(first.source, {page_id: 'concepts/CON'}),
    page(first.source, {root: '/other'}),
    page(first.source, {account_id: other.id}),
    page(first.source, {scope: 'project', project_id: '../escape'}),
    page(first.source, {citations: []}),
    page(first.source, {citations: [{id: first.source.id, start: 0, end: 9999}]}),
    page(first.source, {citations: [{id: 'private/SRC-2026-09-01-999', start: 0, end: 1}]}),
    page(first.source, {text: '# Hook\n\n[[concepts/missing]]'}),
  ]) assert.equal((await call('wiki_write_page', args)).isError, true, JSON.stringify(args));
  assert.equal((await call('wiki_capture_source', {title: 'Raw', text: 'text', source: '../escape'})).isError, true);
  assert.equal((await call('wiki_write_page', page(first.source), 'machine')).isError, true);
});

test('legacy source readers coexist with Wiki anchors and migration preview never rewrites originals', async t => {
  const {personal, data, call} = await fixture(t);
  const saved = await call('ingest_script', {items: [{title: 'Reviewed episode', text: 'LEGACY_SCRIPT_MARKER reviewed text.',
    source: 'project/episode-01', reviewed: true}]});
  assert.equal(saved.isError, undefined);
  const id = /id: (private\/SRC-\d{4}-\d{2}-\d{2}-\d{3})/.exec(saved.content[0].text)[1];
  assert.match(saved.content[0].text, /wiki_write_page/);
  assert.match((await call('read', {id})).content[0].text, /LEGACY_SCRIPT_MARKER/);
  assert.match((await call('read_opening', {id})).content[0].text, /LEGACY_SCRIPT_MARKER/);
  const legacyPath = join(personal, owner.id, 'wiki', 'concepts', 'legacy.md');
  await mkdir(join(personal, owner.id, 'wiki', 'concepts'), {recursive: true});
  await writeFile(legacyPath, '# Legacy page\n\nLEGACY_PAGE_MARKER.');
  const before = await readFile(legacyPath, 'utf8');
  const preview = await data('wiki_migration_preview');
  assert.equal(preview.legacy_pages, 1);
  assert.equal(await readFile(legacyPath, 'utf8'), before);
  const directory = await data('wiki_directory');
  assert.ok(directory.items.some(item => item.id === 'private/wiki/concepts/legacy' && item.revision === 0));
  const write = await data('wiki_write_page', page({id}, {page_id: 'concepts/legacy', citations: [{id, start: 0, end: 10}]}));
  assert.equal(write.revision, 1);
  assert.equal((await data('wiki_read', {id: write.id, revision: 0})).body, before);
  assert.match((await call('search', {query: 'Opening hook'})).content[0].text, /关键词/);
});

test('shared Wiki respects exact grants and administrator-only writes without enabling vectors', async t => {
  let embeddings = 0;
  const grants = new Map();
  const {shared, data, call} = await fixture(t, {documentGrants: grants,
    embedder: {enabled: true, model: 'unused', embed: async () => {embeddings++; return [1];}},
    vectors: {refresh() {}, get() {return [1];}, put() {}, async save() {}}});
  const id = 'SRC-2026-09-01-001', body = 'GRANTED_REFERENCE opening.';
  const packet = join(shared, 'raw', 'sources', id);
  await mkdir(packet, {recursive: true});
  await writeFile(join(packet, 'extracted.md'), body);
  grants.set(id, {kind: 'knowledge', level: 'read', accounts: new Set([owner.id, admin.id]), sha256: sha(body)});
  assert.equal((await data('wiki_search', {scope: 'shared', query: 'GRANTED_REFERENCE'})).results.length, 1);
  assert.equal((await data('wiki_search', {scope: 'shared', query: 'GRANTED_REFERENCE'}, 'other')).results.length, 0);
  assert.equal((await call('wiki_capture_source', {scope: 'shared', title: 'Forbidden', text: 'No', source: 'x'})).isError, true);
  assert.equal((await call('wiki_write_page', page({id}, {scope: 'shared'}))).isError, true);
  await call('search', {query: 'GRANTED_REFERENCE'});
  assert.equal((await call('ingest', {title: 'Machine capture', text: 'Offline only', source: 'test/session'}, 'machine')).isError, true);
  assert.equal(embeddings, 0);
  await writeFile(join(packet, 'extracted.md'), 'CHANGED_UNAPPROVED_BYTES');
  assert.equal((await data('wiki_search', {scope: 'shared', query: 'CHANGED_UNAPPROVED_BYTES'})).results.length, 0);
});

test('compatibility search matches long authorized originals without revealing opening-only tails', async t => {
  const grants = new Map();
  const {shared, data, call} = await fixture(t, {documentGrants: grants});
  const fullId = 'SRC-2026-09-01-007', openingId = 'SRC-2026-09-01-008';
  const marker = 'TAIL_ONLY_EVIDENCE_5921', body = 'prelude '.repeat(60000) + marker;
  for (const id of [fullId, openingId]) {
    await mkdir(join(shared, 'raw', 'sources', id), {recursive: true});
    await writeFile(join(shared, 'raw', 'sources', id, 'extracted.md'), body);
    grants.set(id, {kind: id === fullId ? 'knowledge' : 'viral-script',
      level: id === fullId ? 'read' : 'opening', accounts: new Set([owner.id]), sha256: sha(body)});
  }
  assert.deepEqual((await data('wiki_search', {scope: 'shared', query: marker})).results.map(item => item.id), [fullId]);
  for (const token of ['owner', 'machine']) {
    const result = (await call('search', {query: marker}, token)).content[0].text;
    assert.match(result, new RegExp(fullId));
    assert.match(result, new RegExp(marker));
    assert.doesNotMatch(result, new RegExp(openingId));
  }
  assert.doesNotMatch((await call('search', {query: marker}, 'other')).content[0].text, new RegExp(fullId + '|' + openingId));
  assert.match((await call('read', {id: fullId, start: 480000})).content[0].text, new RegExp(marker));
  assert.equal((await call('read', {id: openingId})).isError, true);
  assert.doesNotMatch((await call('read_opening', {id: openingId, start: 18000})).content[0].text, new RegExp(marker));
  assert.equal((await call('read_opening', {id: openingId, start: 24000})).isError, true);
});

test('parallel writes commit one revision and preserve the losing caller for explicit reload', async t => {
  const {data, call} = await fixture(t);
  const first = await capture(data);
  const results = await Promise.all([
    call('wiki_write_page', page(first.source, {text: '# Hook\n\nWriter A.'})),
    call('wiki_write_page', page(first.source, {text: '# Hook\n\nWriter B.'})),
  ]);
  assert.equal(results.filter(item => !item.isError).length, 1);
  assert.equal(results.filter(item => item.isError).length, 1);
  const history = await data('wiki_history', {id: 'private/wiki/concepts/opening-hook'});
  assert.deepEqual(history.revisions.map(item => item.revision), [1]);
});

test('symlinked account roots and derived page parents cannot expose external bytes', async t => {
  if (process.platform === 'win32') t.skip('Windows symlink creation requires host privileges');
  if (process.platform === 'win32') return;
  const {root, personal, call, data} = await fixture(t);
  const first = await capture(data);
  const external = join(root, 'external');
  await mkdir(external, {mode: 0o700});
  await writeFile(join(external, 'stolen.md'), 'EXTERNAL_PRIVATE_BYTES');
  await symlink(external, join(personal, owner.id, 'wiki', 'stolen'));
  const results = await data('wiki_search', {query: 'EXTERNAL_PRIVATE_BYTES'});
  assert.equal(results.results.length, 0);
  assert.equal((await call('wiki_write_page', page(first.source, {page_id: 'stolen/stolen'}))).isError, true);
});

test('administrator shared updates require grant renewal and expose only the grant-matched revision', async t => {
  const grants = new Map();
  const {shared, data, call} = await fixture(t, {documentGrants: grants});
  const sourceId = 'SRC-2026-09-01-002', sourceBody = 'Administrator-approved evidence.';
  const pageId = 'wiki/concepts/shared-hook', oldBody = '# Shared hook\n\nApproved legacy summary.';
  await mkdir(join(shared, 'raw', 'sources', sourceId), {recursive: true});
  await mkdir(join(shared, 'wiki', 'concepts'), {recursive: true});
  await writeFile(join(shared, 'raw', 'sources', sourceId, 'extracted.md'), sourceBody);
  await writeFile(join(shared, 'wiki', 'concepts', 'shared-hook.md'), oldBody);
  const grant = body => ({kind: 'knowledge', level: 'read', accounts: new Set([owner.id, admin.id]), sha256: sha(body)});
  grants.set(sourceId, grant(sourceBody));
  grants.set(pageId, grant(oldBody));
  const saved = await data('wiki_write_page', {scope: 'shared', page_id: 'concepts/shared-hook', title: 'Shared hook',
    text: '# Shared hook\n\nNew approved summary.', expected_revision: 0,
    citations: [{id: sourceId, start: 0, end: 20}]}, 'admin');
  assert.equal(saved.grant_update_required, true);
  assert.equal((await call('wiki_read', {scope: 'shared', id: pageId})).isError, true);
  grants.set(pageId, grant('# Shared hook\n\nNew approved summary.'));
  const read = await data('wiki_read', {scope: 'shared', id: pageId});
  assert.equal(read.revision, 1);
  assert.equal(read.citations[0].id, sourceId);
  assert.equal((await call('wiki_read', {scope: 'shared', id: pageId, revision: 0})).isError, true);
  assert.deepEqual((await data('wiki_history', {scope: 'shared', id: pageId})).revisions.map(item => item.revision), [1]);
});

test('ordinary machine tokens cannot write shared sources through the compatibility ingest tool', async t => {
  const {shared, call} = await fixture(t);
  const denied = await call('ingest', {title: 'Unauthorized', text: 'No shared write', source: 'test/session'}, 'machine');
  assert.equal(denied.isError, true);
  assert.deepEqual(await readdir(shared), []);
});

test('shared revision metadata cannot substitute ungranted citation text or a private title', async t => {
  const grants = new Map();
  const {shared, data, call} = await fixture(t, {documentGrants: grants});
  const sourceId = 'SRC-2026-09-01-003', sourceBody = 'Readable approved original.';
  const pageId = 'wiki/concepts/metadata', oldBody = '# Metadata\n\nOld text.';
  await mkdir(join(shared, 'raw', 'sources', sourceId), {recursive: true});
  await mkdir(join(shared, 'wiki', 'concepts'), {recursive: true});
  await writeFile(join(shared, 'raw', 'sources', sourceId, 'extracted.md'), sourceBody);
  await writeFile(join(shared, 'wiki', 'concepts', 'metadata.md'), oldBody);
  const grant = body => ({kind: 'knowledge', level: 'read', accounts: new Set([owner.id, admin.id]), sha256: sha(body)});
  grants.set(sourceId, grant(sourceBody)); grants.set(pageId, grant(oldBody));
  const body = '# Metadata\n\nCurrent granted text.';
  await data('wiki_write_page', {scope: 'shared', page_id: 'concepts/metadata', title: 'Metadata', text: body,
    citations: [{id: sourceId, start: 0, end: 10}], expected_revision: 0}, 'admin');
  grants.set(pageId, grant(body));
  const recordPath = join(shared, 'meta', 'wiki-history', sha('concepts/metadata'), '1.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  record.title = 'PRIVATE_METADATA_SECRET';
  record.citations[0].id = 'SRC-2026-09-01-999';
  record.citations[0].excerpt = 'PRIVATE_METADATA_SECRET';
  await writeFile(recordPath, JSON.stringify(record));
  const result = await call('wiki_read', {scope: 'shared', id: pageId});
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_METADATA_SECRET/);
  if (!result.isError) assert.equal(result.structuredContent.citations.length, 0);
});

test('Wiki reads granted source tails beyond the fulltext preview and archives complete legacy shared pages', async t => {
  const grants = new Map();
  const {shared, data} = await fixture(t, {documentGrants: grants});
  const sourceId = 'SRC-2026-09-01-004', sourceBody = 'Opening ' + 'x'.repeat(410000) + 'TAIL_EVIDENCE';
  const pageId = 'wiki/concepts/long-legacy', oldBody = '# Long legacy\n' + 'x'.repeat(410000) + 'LEGACY_TAIL';
  await mkdir(join(shared, 'raw', 'sources', sourceId), {recursive: true});
  await mkdir(join(shared, 'wiki', 'concepts'), {recursive: true});
  await writeFile(join(shared, 'raw', 'sources', sourceId, 'extracted.md'), sourceBody);
  await writeFile(join(shared, 'wiki', 'concepts', 'long-legacy.md'), oldBody);
  const grant = body => ({kind: 'knowledge', level: 'read', accounts: new Set([owner.id, admin.id]), sha256: sha(body)});
  grants.set(sourceId, grant(sourceBody)); grants.set(pageId, grant(oldBody));
  const tail = await data('wiki_read', {scope: 'shared', id: sourceId, start: 408000});
  assert.match(tail.body, /TAIL_EVIDENCE/);
  await data('wiki_write_page', {scope: 'shared', page_id: 'concepts/long-legacy', title: 'Long legacy',
    text: '# Long legacy\n\nShort synthesis.', citations: [{id: sourceId, start: 0, end: 7}], expected_revision: 0}, 'admin');
  const baseline = JSON.parse(await readFile(join(shared, 'meta', 'wiki-history', sha('concepts/long-legacy'), '0.json'), 'utf8'));
  assert.equal(baseline.body, oldBody);
  assert.equal(baseline.sha256, sha(oldBody));
});

test('quoted legacy Markdown survives JSON expansion in the immutable history reader', async t => {
  const {personal, data} = await fixture(t);
  const source = await capture(data);
  const oldBody = '# Legacy\n' + '"quoted text"\n'.repeat(28000);
  const path = join(personal, owner.id, 'wiki', 'concepts', 'quoted.md');
  await mkdir(join(personal, owner.id, 'wiki', 'concepts'), {recursive: true});
  await writeFile(path, oldBody);
  await data('wiki_write_page', page(source.source, {page_id: 'concepts/quoted'}));
  assert.equal((await data('wiki_read', {id: 'private/wiki/concepts/quoted', revision: 0})).body, Array.from(oldBody).slice(0, 6000).join(''));
  assert.deepEqual((await data('wiki_history', {id: 'private/wiki/concepts/quoted'})).revisions.map(item => item.revision), [1, 0]);
});

test('administrators can create cited shared pages that remain invisible until explicitly granted', async t => {
  const grants = new Map();
  const {shared, data, call} = await fixture(t, {documentGrants: grants});
  const id = 'SRC-2026-09-01-005', text = 'Approved original knowledge.';
  await mkdir(join(shared, 'raw', 'sources', id), {recursive: true});
  await writeFile(join(shared, 'raw', 'sources', id, 'extracted.md'), text);
  const grant = body => ({kind: 'knowledge', level: 'read', accounts: new Set([owner.id, admin.id]), sha256: sha(body)});
  grants.set(id, grant(text));
  const args = {scope: 'shared', page_id: 'concepts/new-shared', title: 'Shared concept',
    text: '# Shared concept\n\nA cited summary.', citations: [{id, start: 0, end: 8}], expected_revision: 0};
  const saved = await data('wiki_write_page', args, 'admin');
  assert.equal(saved.grant_update_required, true);
  assert.equal((await call('wiki_read', {scope: 'shared', id: saved.id})).isError, true);
  grants.set(saved.id, grant(args.text));
  assert.equal((await data('wiki_read', {scope: 'shared', id: saved.id})).revision, 1);
  await writeFile(join(shared, 'wiki', 'concepts', 'ungranted.md'), 'UNGRANTED_EXISTING_PAGE');
  assert.equal((await call('wiki_write_page', {...args, page_id: 'concepts/ungranted'}, 'admin')).isError, true);
});
test('machine administration without an explicit scope cannot capture into shared storage', async t => {
  const {shared, call} = await fixture(t);
  const result = await call('wiki_capture_source', {title: 'Default scope', text: 'Must require account login', source: 'note'}, 'admin-machine');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /account login/i);
  assert.deepEqual(await readdir(shared), []);
});

for (const kind of ['private', 'project', 'legacy']) {
  test(`${kind} capture rejects redirected source storage without writing another account`, async t => {
    const {personal, call} = await fixture(t);
    const own = kind === 'project' ? join(personal, owner.id, 'projects', 'drama-one') : join(personal, owner.id);
    const otherSources = join(personal, other.id, 'raw', 'sources');
    await mkdir(own, {recursive: true});
    await mkdir(otherSources, {recursive: true});
    const redirected = join(own, 'raw');
    await symlink(join(personal, other.id, 'raw'), redirected, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const result = kind === 'legacy'
        ? await call('ingest_script', {items: [{title: 'Capture', text: 'ACCOUNT_CAPTURE_MARKER', source: 'note', reviewed: true}]})
        : await call('wiki_capture_source', {title: 'Capture', text: 'ACCOUNT_CAPTURE_MARKER', source: 'note',
          ...(kind === 'project' ? {scope: 'project', project_id: 'drama-one'} : {})});
      if (kind === 'legacy') assert.match(result.content[0].text, /失败/);
      else assert.equal(result.isError, true);
      assert.deepEqual(await readdir(otherSources), []);
    } finally { await unlink(redirected); }
  });
}

test('shared history without a Markdown projection cannot authorize another revision', async t => {
  const grants = new Map();
  const {shared, data, call} = await fixture(t, {documentGrants: grants});
  const id = 'SRC-2026-09-01-006', text = 'Approved original knowledge.';
  await mkdir(join(shared, 'raw', 'sources', id), {recursive: true});
  await writeFile(join(shared, 'raw', 'sources', id, 'extracted.md'), text);
  grants.set(id, {kind: 'knowledge', level: 'read', accounts: new Set([admin.id]), sha256: sha(text)});
  const args = {scope: 'shared', page_id: 'concepts/history-only', title: 'Shared concept',
    text: '# Shared concept\n\nA cited summary.', citations: [{id, start: 0, end: 8}], expected_revision: 0};
  await data('wiki_write_page', args, 'admin');
  await rm(join(shared, 'wiki', 'concepts', 'history-only.md'));
  const result = await call('wiki_write_page', {...args, expected_revision: 1, text: '# Updated shared concept'}, 'admin');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /full-read grant/i);
  assert.deepEqual(await readdir(join(shared, 'meta', 'wiki-history', sha(args.page_id))), ['1.json']);
});
