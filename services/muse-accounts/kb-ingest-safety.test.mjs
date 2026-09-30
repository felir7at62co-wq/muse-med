import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ingestSession} from './kb-vault.mjs';

const capture = {title: 'Capture', text: 'ACCOUNT_CAPTURE_MARKER', source: 'project/episode-01'};
const sha = value => createHash('sha256').update(value).digest('hex');
const now = new Date('2026-09-30T00:00:00.000Z');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-ingest-safety-'));
  const redirects = [];
  t.after(async () => {
    for (const path of redirects.reverse()) await unlink(path);
    await rm(root, {recursive: true, force: true});
  });
  const vault = join(root, 'vault'), other = join(root, 'other');
  await mkdir(vault);
  await mkdir(join(other, 'raw', 'sources'), {recursive: true});
  await mkdir(join(other, 'meta'));
  const redirect = async (target, path, type = process.platform === 'win32' ? 'junction' : 'dir') => {
    await symlink(target, path, type);
    redirects.push(path);
  };
  return {root, vault, other, redirect};
}

for (const part of ['root', 'raw', 'sources', 'meta']) {
  test(`source capture rejects redirected ${part} storage before writing another vault`, async t => {
    const {vault, other, redirect} = await fixture(t);
    if (part === 'root') {
      await rm(vault, {recursive: true});
      await redirect(other, vault);
    } else if (part === 'raw') await redirect(join(other, 'raw'), join(vault, 'raw'));
    else if (part === 'sources') {
      await mkdir(join(vault, 'raw'));
      await redirect(join(other, 'raw', 'sources'), join(vault, 'raw', 'sources'));
    } else await redirect(join(other, 'meta'), join(vault, 'meta'));
    await assert.rejects(ingestSession(vault, capture, {now}), /regular directory/);
    assert.deepEqual(await readdir(join(other, 'raw', 'sources')), []);
    assert.deepEqual(await readdir(join(other, 'meta')), []);
  });
}

test('source capture rejects a redirected packet instead of treating another vault as a duplicate', async t => {
  const {vault, other, redirect} = await fixture(t);
  const id = 'SRC-2026-09-30-001', packet = join(other, 'raw', 'sources', id);
  await mkdir(packet);
  await writeFile(join(packet, 'manifest.json'), JSON.stringify({id, content_sha256: sha(capture.text)}));
  await writeFile(join(packet, 'extracted.md'), capture.text);
  await mkdir(join(vault, 'raw', 'sources'), {recursive: true});
  await redirect(packet, join(vault, 'raw', 'sources', id));
  await assert.rejects(ingestSession(vault, capture, {now}), /regular directory/);
  assert.deepEqual(await readdir(join(other, 'raw', 'sources')), [id]);
  assert.equal(await readFile(join(packet, 'extracted.md'), 'utf8'), capture.text);
});

for (const name of ['manifest.json', 'extracted.md']) {
  test(`source capture rejects a symlinked ${name} in an existing packet`, {skip: process.platform === 'win32'
    ? 'Windows file symlink creation requires host privileges' : false}, async t => {
    const {root, vault, redirect} = await fixture(t);
    const id = 'SRC-2026-09-30-001', packet = join(vault, 'raw', 'sources', id);
    await mkdir(packet, {recursive: true});
    const files = {'manifest.json': JSON.stringify({id, content_sha256: sha(capture.text)}), 'extracted.md': capture.text};
    for (const [filename, contents] of Object.entries(files)) {
      if (filename === name) {
        const outside = join(root, 'outside-' + filename);
        await writeFile(outside, contents);
        await redirect(outside, join(packet, filename), 'file');
      } else await writeFile(join(packet, filename), contents);
    }
    await assert.rejects(ingestSession(vault, capture, {now}), /regular file/);
    assert.deepEqual(await readdir(join(vault, 'raw', 'sources')), [id]);
  });
}

test('source capture does not reuse a manifest hash after the immutable original changes', async t => {
  const {vault} = await fixture(t);
  const saved = await ingestSession(vault, capture, {now});
  await writeFile(join(saved.path, 'extracted.md'), 'CHANGED_ORIGINAL');
  await assert.rejects(ingestSession(vault, capture, {now}), /source hash/);
  assert.equal(await readFile(join(saved.path, 'extracted.md'), 'utf8'), 'CHANGED_ORIGINAL');
  assert.deepEqual(await readdir(join(vault, 'raw', 'sources')), [saved.id]);
});

test('source capture preserves duplicate IDs in existing regular storage directories', async t => {
  const {vault} = await fixture(t);
  await mkdir(join(vault, 'raw', 'sources'), {recursive: true});
  await mkdir(join(vault, 'meta'));
  const first = await ingestSession(vault, capture, {now});
  const repeated = await ingestSession(vault, capture, {now});
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.duplicate, true);
  assert.equal(await readFile(join(first.path, 'extracted.md'), 'utf8'), capture.text);
});
