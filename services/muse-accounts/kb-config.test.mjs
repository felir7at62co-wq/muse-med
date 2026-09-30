import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('Wiki startup loads roots and grants while ignoring legacy embedding configuration', async t => {
  const {loadKnowledgeBase} = await import('./gateway.mjs');
  assert.equal(typeof loadKnowledgeBase, 'function');
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-config-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const shared = join(root, 'shared'), personal = join(root, 'personal');
  const secret = 'test-only-secret-longer-than-thirty-two-characters';
  await mkdir(shared, {mode: 0o700});
  await mkdir(personal, {mode: 0o700});
  await writeFile(join(root, 'secret'), secret, {mode: 0o600});
  await writeFile(join(root, 'grants.json'), JSON.stringify({version: 1, grants: []}), {mode: 0o600});
  const environment = {MUSE_KB_VAULT: shared, MUSE_KB_USER_ROOT: personal,
    MUSE_KB_SECRET: join(root, 'secret'), MUSE_KB_DOCUMENT_GRANTS: join(root, 'grants.json'),
    MUSE_KB_EMBEDDING_KEY: join(root, 'missing-key'), MUSE_KB_VECTORS: join(root, 'missing-vectors'),
    MUSE_KB_EMBEDDING_MODEL: 'unused', MUSE_KB_EMBEDDING_ENDPOINT: 'http://127.0.0.1:1'};
  const config = await loadKnowledgeBase(environment);
  assert.deepEqual(Object.keys(config).sort(), ['documentGrants', 'personalRoot', 'portfolioReaders', 'secret', 'vaultRoot']);
  assert.equal(config.vaultRoot, shared);
  assert.equal(config.personalRoot, personal);
  assert.equal(config.secret, secret);
  assert.equal(config.documentGrants.size, 0);
  assert.equal(config.portfolioReaders.size, 0);
  assert.equal((await loadKnowledgeBase({...environment, MUSE_KB_DOCUMENT_GRANTS: undefined})).documentGrants.size, 0);
  await assert.rejects(loadKnowledgeBase({...environment, MUSE_KB_USER_ROOT: undefined}), /existing owner-only absolute directory/);
});

test('Wiki startup remains disabled without vault and secret configuration', async () => {
  const {loadKnowledgeBase} = await import('./gateway.mjs');
  assert.equal(typeof loadKnowledgeBase, 'function');
  assert.equal(await loadKnowledgeBase({}), undefined);
});

test('Wiki startup loads explicit portfolio readers and rejects invalid or account-writable configuration', async t => {
  const {loadKnowledgeBase} = await import('./gateway.mjs');
  const root = await mkdtemp(join(tmpdir(), 'muse-kb-portfolio-config-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const shared = join(root, 'shared'), personal = join(root, 'personal');
  await mkdir(shared, {mode: 0o700}); await mkdir(personal, {mode: 0o700});
  await writeFile(join(root, 'secret'), 'test-only-secret-longer-than-thirty-two-characters', {mode: 0o600});
  const file = join(root, 'readers.json'), id = '0123456789abcdef';
  await writeFile(file, JSON.stringify({version: 1, accountIds: [id]}), {mode: 0o600});
  const environment = {MUSE_KB_VAULT: shared, MUSE_KB_USER_ROOT: personal,
    MUSE_KB_SECRET: join(root, 'secret'), MUSE_KB_PORTFOLIO_READERS: file};
  assert.deepEqual((await loadKnowledgeBase(environment)).portfolioReaders, new Set([id]));
  await writeFile(file, JSON.stringify({version: 1, accountIds: [id, id]}));
  await assert.rejects(loadKnowledgeBase(environment), /Invalid portfolio readers file/);
  const accountFile = join(personal, 'readers.json');
  await writeFile(accountFile, JSON.stringify({version: 1, accountIds: [id]}), {mode: 0o600});
  await assert.rejects(loadKnowledgeBase({...environment, MUSE_KB_PORTFOLIO_READERS: accountFile}), /outside the personal root/);
});
