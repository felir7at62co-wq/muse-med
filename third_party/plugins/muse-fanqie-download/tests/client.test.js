/** Offline publication and lifecycle regressions with isolated per-test workspaces. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bookId, FanqieClient, resolveConfig } from '../src/client.js';
import { apply } from '../src/index.js';

const ids = ['7670371803641957400', '7069947196146093097'];
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-fanqie-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function engine(produce) {
  return { resolveExecutable: async value => value, spawn(spec) {
    let stdout = '';
    const done = produce(spec).then(result => { stdout = JSON.stringify(result); return { exitCode: result.ok ? 0 : 1, signal: null }; });
    return { done, waitForExit: () => done.then(() => true), terminate() {}, collected: { stdout: { readFrom: () => ({ text: stdout, lossy: false }) } } };
  } };
}

async function produce(spec) {
  const args = JSON.parse(spec.stdio.stdin.data), items = [];
  for (const bookId of args.bookIds) {
    const text = `A complete invented chapter for ${bookId}\n`, file = `${bookId}.txt`;
    await writeFile(join(args.staging, file), text, { flag: 'wx' });
    items.push({ bookId, file, title: 'Invented fixture', chapterCount: 1, downloadedChapters: 1,
      chapters: [{ itemId: `${bookId}1` }], complete: true, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
  }
  return { ok: true, complete: true, items };
}

test('preserves decimal book IDs and validates deployment limits and official links', () => {
  assert.equal(bookId(`https://fanqienovel.com/page/${ids[0]}?source=share`), ids[0]);
  assert.equal(bookId(ids[0]), ids[0]);
  for (const value of [Number(ids[0]), 'http://fanqienovel.com/page/' + ids[0], 'https://evil.test/page/' + ids[0], 'https://fanqienovel.com/reader/' + ids[0]]) assert.throws(() => bookId(value));
  for (const config of [{ maxBooks: 0 }, { batchSize: -1 }, { mystery: true }, null]) assert.throws(() => resolveConfig(config));
});

test('publishes a complete multi-book batch with verified hashes and absolute receipts', async t => {
  const root = await workspace(t), client = new FanqieClient({ pythonExecutable: 'python' }, engine(produce));
  t.after(() => client.dispose());
  const result = await client.call('download', { bookIds: ids }, root);
  assert.equal(result.complete, true);
  assert.equal(result.items.length, 2);
  for (const item of result.items) assert.equal(createHash('sha256').update(await readFile(item.file)).digest('hex'), item.sha256);
  assert.deepEqual(await readdir(join(root, 'downloads/fanqie')), [result.outputDir.split(/[\\/]/u).at(-1)]);
});

test('cleans the whole batch when a chapter, identity or published hash fails', async t => {
  const root = await workspace(t);
  for (const mutate of [r => { r.items[1].sha256 = 'wrong'; }, r => { r.items[1].complete = false; }, r => { r.items[1].bookId = ids[0]; }]) {
    const client = new FanqieClient({ pythonExecutable: 'python' }, engine(async spec => { const result = await produce(spec); mutate(result); return result; }));
    assert.equal((await client.call('download', { bookIds: ids }, root)).ok, false);
    await client.dispose();
    assert.deepEqual(await readdir(join(root, 'downloads/fanqie')), []);
  }
});

test('publishes only declared books and accepts the session workspace path spelling', async t => {
  const root = await workspace(t);
  const client = new FanqieClient({ pythonExecutable: 'python' }, engine(async spec => {
    const result = await produce(spec);
    await writeFile(join(JSON.parse(spec.stdio.stdin.data).staging, 'unexpected.txt'), 'not a book');
    return result;
  }));
  assert.equal((await client.call('download', { bookIds: ids, outputDir: join(root, 'downloads') }, root)).ok, false);
  assert.deepEqual(await readdir(join(root, 'downloads')), []);
  await client.dispose();
});

test('rejects duplicate IDs and output escapes before starting a process', async t => {
  const root = await workspace(t), outside = await workspace(t), service = engine(() => { throw new Error('Must not start'); });
  const client = new FanqieClient({ pythonExecutable: 'python' }, service);
  t.after(() => client.dispose());
  for (const args of [{ bookIds: [ids[0], ids[0]] }, { bookIds: ids, outputDir: outside }, { bookIds: ids, outputDir: '../outside' }]) assert.equal((await client.call('download', args, root)).ok, false);
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await client.call('download', { bookIds: ids, outputDir: 'linked' }, root)).ok, false);
  assert.deepEqual(await readdir(outside), []);
});

test('disposal waits for the owned engine and removes its partial book', async t => {
  const root = await workspace(t);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const client = new FanqieClient({ pythonExecutable: 'python' }, engine(async spec => {
    const args = JSON.parse(spec.stdio.stdin.data);
    await writeFile(join(args.staging, `${ids[0]}.txt`), 'partial');
    const aborted = new Promise(resolve => spec.signal.addEventListener('abort', resolve, { once: true }));
    started();
    await aborted;
    return { ok: false, code: 'cancelled' };
  }));
  const call = client.call('download', { bookIds: [ids[0]] }, root);
  await ready;
  await client.dispose();
  assert.equal((await call).code, 'cancelled');
  assert.deepEqual(await readdir(join(root, 'downloads/fanqie')), []);
});

test('registers model tools without loading Python or contacting the platform', async () => {
  const definitions = [], disposers = [];
  apply({ subprocess: {}, agents: {}, tools: { register(value) { definitions.push(value); return () => {}; } }, effect(callback) { disposers.push(callback()); } });
  assert.deepEqual(definitions.map(value => value.name), ['fanqie_search', 'fanqie_download_info', 'fanqie_download']);
  for (const dispose of disposers.reverse()) await dispose();
});

test('search returns distinguishable candidates and an opaque next-page cursor without creating files', async t => {
  const root = await workspace(t), requests = [];
  const client = new FanqieClient({ pythonExecutable: 'python' }, engine(async spec => {
    const request = JSON.parse(spec.stdio.stdin.data);
    requests.push(request);
    assert.equal(request.operation, 'search');
    assert.equal(request.staging, undefined);
    return { ok: true, complete: false, query: request.query, hasMore: requests.length === 1,
      nextPassback: requests.length === 1 ? 'opaque:next' : null,
      items: ids.map((bookId, index) => ({ bookId, title: '同名测试', author: `作者${index}`,
        originalTitle: null, chapterCount: 1, url: `https://fanqienovel.com/page/${bookId}` })) };
  }));
  t.after(() => client.dispose());
  const first = await client.call('search', { query: ' 同名测试 ' }, root);
  assert.equal(first.ok, true);
  assert.equal(first.complete, false);
  assert.notEqual(first.items[0].author, first.items[1].author);
  const second = await client.call('search', { query: first.query, passback: first.nextPassback }, root);
  assert.equal(second.hasMore, false);
  assert.deepEqual(requests.map(request => request.passback), ['0', 'opaque:next']);
  assert.deepEqual(await readdir(root), []);
});

test('search rejects invalid inputs before spawn and malformed engine results before reporting success', async t => {
  const root = await workspace(t);
  const invalid = new FanqieClient({ pythonExecutable: 'python' }, engine(() => { throw new Error('Must not start'); }));
  t.after(() => invalid.dispose());
  for (const args of [{ query: '' }, { query: ' ' }, { query: 3 }, { query: '书', outputDir: 'novels' }, { query: '书', passback: 10 }]) {
    assert.equal((await invalid.call('search', args, root)).code, 'invalid_arguments');
  }
  for (const change of [r => { r.complete = true; }, r => { r.query = 'wrong'; }, r => { r.nextPassback = null; },
    r => { r.items[0].bookId = Number(ids[0]); }, r => { r.items[0].url = 'https://evil.test'; }]) {
    const client = new FanqieClient({ pythonExecutable: 'python' }, engine(async () => {
      const result = { ok: true, complete: false, query: '书', hasMore: true, nextPassback: '10',
        items: [{ bookId: ids[0], title: '书', author: '作者', originalTitle: null, chapterCount: 1,
          url: `https://fanqienovel.com/page/${ids[0]}` }] };
      change(result);
      return result;
    }));
    assert.equal((await client.call('search', { query: '书' }, root)).ok, false);
    await client.dispose();
  }
  assert.deepEqual(await readdir(root), []);
});
