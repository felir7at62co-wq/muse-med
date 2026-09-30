import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadPortfolioReaders} from './kb-portfolio-config.mjs';

const accountId = '0123456789abcdef';
const otherId = 'fedcba9876543210';
const enabled = {version: 1, accountIds: [accountId, otherId]};
const symlinkSkip = process.platform === 'win32' ? 'Windows file symlinks require privileges not granted to the test runner' : false;

async function fixture(t, document = enabled) {
  const root = await mkdtemp(join(tmpdir(), 'muse-portfolio-config-'));
  const links = [];
  t.after(async () => {
    for (const path of links.reverse()) await unlink(path);
    await rm(root, {recursive: true, force: true});
  });
  const vaultRoot = join(root, 'shared'), personalRoot = join(root, 'personal');
  await mkdir(vaultRoot, {mode: 0o700});
  await mkdir(personalRoot, {mode: 0o700});
  const file = join(root, 'portfolio-readers.json');
  await writeFile(file, JSON.stringify(document), {mode: 0o600});
  const redirect = async (target, path, type) => {
    await symlink(target, path, type);
    links.push(path);
  };
  return {root, file, options: {vaultRoot, personalRoot}, redirect};
}

test('an external administrator file enables exactly the declared account IDs', async t => {
  const {file, options} = await fixture(t);
  const readers = await loadPortfolioReaders(file, options);
  assert.ok(readers instanceof Set);
  assert.deepEqual([...readers], enabled.accountIds);
  assert.equal(readers.has('aaaaaaaaaaaaaaaa'), false);
});

test('an empty configured account list enables nobody', async t => {
  const {file, options} = await fixture(t, {version: 1, accountIds: []});
  assert.deepEqual(await loadPortfolioReaders(file, options), new Set());
});

test('the account list accepts the declared maximum of one thousand distinct IDs', async t => {
  const accountIds = Array.from({length: 1000}, (_, index) => index.toString(16).padStart(16, '0'));
  const {file, options} = await fixture(t, {version: 1, accountIds});
  assert.deepEqual(await loadPortfolioReaders(file, options), new Set(accountIds));
});

const invalidDocuments = [
  ['null', null],
  ['an array', []],
  ['an unsupported version', {version: 2, accountIds: []}],
  ['a string version', {version: '1', accountIds: []}],
  ['a missing version', {accountIds: []}],
  ['a missing account list', {version: 1}],
  ['an unknown field', {...enabled, usernames: ['owner']}],
  ['a non-array account list', {version: 1, accountIds: accountId}],
  ['an account name', {version: 1, accountIds: ['owner']}],
  ['an uppercase account ID', {version: 1, accountIds: ['0123456789ABCDEF']}],
  ['a short account ID', {version: 1, accountIds: ['0123456789abcde']}],
  ['a long account ID', {version: 1, accountIds: ['0123456789abcdef0']}],
  ['a non-string account ID', {version: 1, accountIds: [123]}],
  ['a null account ID', {version: 1, accountIds: [null]}],
  ['duplicate account IDs', {version: 1, accountIds: [accountId, accountId]}],
  ['more than one thousand IDs', {version: 1, accountIds: Array.from({length: 1001}, (_, index) => index.toString(16).padStart(16, '0'))}],
];
for (const [reason, document] of invalidDocuments) {
  test(`the configuration rejects ${reason}`, async t => {
    const {file, options} = await fixture(t, document);
    await assert.rejects(loadPortfolioReaders(file, options), /Invalid portfolio readers file/);
  });
}

test('malformed JSON rejects configuration loading', async t => {
  const {file, options} = await fixture(t);
  await writeFile(file, '{');
  await assert.rejects(loadPortfolioReaders(file, options), SyntaxError);
});

test('a configuration path must be explicitly absolute', async () => {
  for (const file of [undefined, '', 'portfolio-readers.json']) {
    await assert.rejects(loadPortfolioReaders(file), /absolute path/);
  }
});

test('a missing configured file fails instead of enabling an empty list', async t => {
  const {root, options} = await fixture(t);
  await assert.rejects(loadPortfolioReaders(join(root, 'missing.json'), options), {code: 'ENOENT'});
});

test('a directory cannot serve as the administrator configuration file', async t => {
  const {root, options} = await fixture(t);
  await assert.rejects(loadPortfolioReaders(root, options), /administrator-maintained regular file/);
});

test('the configuration file rejects content larger than 256 KiB', async t => {
  const {file, options} = await fixture(t);
  await writeFile(file, ' '.repeat(256 * 1024 + 1));
  await assert.rejects(loadPortfolioReaders(file, options), /administrator-maintained regular file/);
});

test('a valid configuration accepts exactly 256 KiB including JSON whitespace', async t => {
  const {file, options} = await fixture(t);
  const body = JSON.stringify(enabled);
  await writeFile(file, body + ' '.repeat(256 * 1024 - Buffer.byteLength(body)));
  assert.deepEqual(await loadPortfolioReaders(file, options), new Set(enabled.accountIds));
});

for (const [key, label] of [['vaultRoot', 'shared vault'], ['personalRoot', 'personal root']]) {
  test(`the configuration cannot be stored inside the ${label}`, async t => {
    const {options} = await fixture(t);
    const file = join(options[key], 'portfolio-readers.json');
    await writeFile(file, JSON.stringify(enabled), {mode: 0o600});
    await assert.rejects(loadPortfolioReaders(file, options), new RegExp(`outside the ${label}`));
  });

  test(`canonical paths prevent an alias into the ${label}`, {skip: symlinkSkip}, async t => {
    const {root, options, redirect} = await fixture(t);
    const alias = join(root, key + '-alias');
    await redirect(options[key], alias, 'dir');
    const file = join(options[key], 'portfolio-readers.json');
    await writeFile(file, JSON.stringify(enabled), {mode: 0o600});
    await assert.rejects(loadPortfolioReaders(join(alias, 'portfolio-readers.json'), options), new RegExp(`outside the ${label}`));
    await assert.rejects(loadPortfolioReaders(file, {...options, [key]: alias}), new RegExp(`outside the ${label}`));
  });
}

test('a neighboring directory with the vault name prefix remains outside it', async t => {
  const {root, options} = await fixture(t);
  const neighbor = join(root, 'shared-admin');
  await mkdir(neighbor, {mode: 0o700});
  const file = join(neighbor, 'portfolio-readers.json');
  await writeFile(file, JSON.stringify(enabled), {mode: 0o600});
  assert.deepEqual(await loadPortfolioReaders(file, options), new Set(enabled.accountIds));
});

test('a symbolic link cannot serve as the administrator configuration file', {skip: symlinkSkip}, async t => {
  const {root, file, options, redirect} = await fixture(t);
  const alias = join(root, 'readers-link.json');
  await redirect(file, alias, 'file');
  await assert.rejects(loadPortfolioReaders(alias, options), /administrator-maintained regular file/);
});

for (const [label, mode] of [['group', 0o620], ['world', 0o602]]) {
  test(`a ${label}-writable administrator file is refused on POSIX`, {
    skip: process.platform === 'win32' ? 'Windows does not enforce POSIX group and world mode bits' : false,
  }, async t => {
    const {file, options} = await fixture(t);
    await chmod(file, mode);
    await assert.rejects(loadPortfolioReaders(file, options), /administrator-maintained regular file/);
  });
}
