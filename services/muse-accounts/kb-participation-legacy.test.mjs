import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWikiService} from './kb-wiki.mjs';

const owner = {id: '0123456789abcdef', username: 'owner'};
const other = {id: 'fedcba9876543210', username: 'other'};
const admin = {id: 'aaaaaaaaaaaaaaaa', username: 'admin', admin: true};
const legacy = 'wiki/concepts/-temporal-need-threat-model';
const source = 'SRC-2026-09-30-001';
const sourceText = 'Original research supporting the legacy concept.';
const legacyText = '# Legacy concept\n\nPreserved original analysis. [[concepts/neighbor]]';
const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-wiki-legacy-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const shared = join(root, 'shared'), personal = join(root, 'personal');
  await mkdir(join(shared, 'wiki', 'concepts'), {recursive: true, mode: 0o700});
  await mkdir(join(shared, 'raw', 'sources', source), {recursive: true, mode: 0o700});
  await mkdir(personal, {mode: 0o700});
  const entries = [[legacy, legacyText], ['wiki/concepts/neighbor', '# Neighbor\n\n[[concepts/-temporal-need-threat-model]]']];
  const grants = new Map();
  for (const [id, body] of entries) {
    await writeFile(join(shared, 'wiki', id.slice(5) + '.md'), body);
    grants.set(id, {kind: 'knowledge', level: 'read', sha256: sha(body), accounts: new Set([owner.id, admin.id])});
  }
  await writeFile(join(shared, 'raw', 'sources', source, 'extracted.md'), sourceText);
  grants.set(source, {kind: 'knowledge', level: 'read', sha256: sha(sourceText), accounts: new Set([owner.id, admin.id])});
  const wiki = createWikiService({vaultRoot: shared, personalRoot: personal, documentGrants: grants});
  const call = (name, args, account = owner) => wiki.call(name, args, account, 'account');
  return {shared, personal, grants, call};
}

test('granted legacy page IDs remain readable with revision and link navigation', async t => {
  const {call} = await fixture(t);
  const directory = await call('wiki_directory', {scope: 'shared'});
  assert.ok(directory.items.some(item => item.id === legacy));
  const read = await call('wiki_read', {scope: 'shared', id: legacy});
  assert.equal(read.body, legacyText);
  assert.equal(read.sha256, sha(legacyText));
  const history = await call('wiki_history', {scope: 'shared', id: legacy});
  assert.equal(history.total, 1);
  assert.equal(history.revisions[0].revision, 0);
  const links = await call('wiki_links', {scope: 'shared', id: legacy});
  assert.deepEqual(links.outgoing, ['wiki/concepts/neighbor']);
  assert.deepEqual(links.backlinks.map(item => item.id), ['wiki/concepts/neighbor']);
});

test('legacy reads preserve exact grants and reject other accounts and unsafe paths', async t => {
  const {call, shared} = await fixture(t);
  for (const name of ['wiki_read', 'wiki_history', 'wiki_links']) {
    await assert.rejects(call(name, {scope: 'shared', id: legacy}, other), /not authorized/);
    for (const id of ['wiki/concepts/../outside', 'wiki/concepts/..\\outside', 'wiki//outside']) {
      await assert.rejects(call(name, {scope: 'shared', id}), /Invalid document ID/);
    }
  }
  await writeFile(join(shared, 'wiki', legacy.slice(5) + '.md'), legacyText + '\nChanged bytes.');
  await assert.rejects(call('wiki_read', {scope: 'shared', id: legacy}), /not authorized/);
});

test('legacy read names do not permit new writes or overwrite granted originals', async t => {
  const {call, shared} = await fixture(t);
  const file = join(shared, 'wiki', legacy.slice(5) + '.md');
  await assert.rejects(call('wiki_write_page', {scope: 'shared', page_id: legacy.slice(5),
    title: 'Replacement', text: '# Replacement', expected_revision: 0,
    citations: [{id: source, start: 0, end: 20}]}, admin), /safe page ID/);
  assert.equal(await readFile(file, 'utf8'), legacyText);
});

test('private and project legacy reads retain their account-owned directories', async t => {
  const {call, personal} = await fixture(t);
  for (const scope of ['private', 'project']) {
    const args = scope === 'project' ? {scope, project_id: 'drama-one'} : {scope};
    const root = scope === 'project' ? join(personal, owner.id, 'projects', 'drama-one') : join(personal, owner.id);
    await mkdir(join(root, 'wiki', 'concepts'), {recursive: true, mode: 0o700});
    await writeFile(join(root, 'wiki', legacy.slice(5) + '.md'), legacyText);
    const id = scope === 'project' ? 'project/drama-one/' + legacy : 'private/' + legacy;
    assert.equal((await call('wiki_read', {...args, id})).body, legacyText);
    await assert.rejects(call('wiki_read', {...args, id}, other), /not authorized/);
  }
});
