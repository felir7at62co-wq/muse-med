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
  assert.equal(resolveConfig().networkMode, 'direct');
  assert.equal(resolveConfig({ networkMode: 'system' }).networkMode, 'system');
  for (const config of [{ maxBooks: 0 }, { batchSize: -1 }, { mystery: true }, { networkMode: 'proxy' }, { networkMode: true }, null]) assert.throws(() => resolveConfig(config));
});

test('launches isolated Python in UTF-8 mode and passes the selected network policy', async t => {
  const root = await workspace(t);
  for (const networkMode of ['direct', 'system']) {
    const client = new FanqieClient({ pythonExecutable: 'python', networkMode }, engine(async spec => {
      assert.deepEqual(spec.argv.slice(0, -1), ['python', '-I', '-B', '-X', 'utf8']);
      assert.match(spec.argv.at(-1), /[/\\]python[/\\]engine\.py$/u);
      const request = JSON.parse(spec.stdio.stdin.data);
      assert.equal(request.settings.networkMode, networkMode);
      return { ok: true, complete: false, query: request.query, hasMore: false, nextPassback: null, items: [] };
    }));
    assert.equal((await client.call('search', { query: '书' }, root)).ok, true);
    await client.dispose();
  }
});

test('returns the failed stage and specific connection error while cleaning partial downloads', async t => {
  const root = await workspace(t);
  const client = new FanqieClient({ pythonExecutable: 'python', networkMode: 'system' }, engine(async spec => {
    await writeFile(join(JSON.parse(spec.stdio.stdin.data).staging, `${ids[0]}.txt`), 'partial');
    return { ok: false, code: 'URLError', sourceStage: 'registration', host: 'log.snssdk.com', networkMode: 'system',
      privateResponse: 'not model-visible', error: { type: 'URLError', reasonType: 'SSLEOFError', message: 'TLS connection ended unexpectedly', privateToken: 'not model-visible' } };
  }));
  t.after(() => client.dispose());
  const result = await client.call('download', { bookIds: [ids[0]] }, root);
  assert.equal(result.code, 'URLError');
  assert.equal(result.sourceStage, 'registration');
  assert.equal(result.host, 'log.snssdk.com');
  assert.equal(result.networkMode, 'system');
  assert.equal(result.error.reasonType, 'SSLEOFError');
  assert.match(result.message, /registration.*log\.snssdk\.com.*system.*TLS connection ended unexpectedly/u);
  assert.equal(JSON.stringify(result).includes('not model-visible'), false);
  assert.deepEqual(await readdir(join(root, 'downloads/fanqie')), []);
});

test('rejects malformed engine diagnostics instead of forwarding them to the model', async t => {
  const root = await workspace(t);
  for (const change of [r => { r.host = 'evil.test'; }, r => { r.sourceStage = 'unknown'; }, r => { r.networkMode = 'system'; },
    r => { r.error.message = 'x'.repeat(513); }, r => { r.error.type = 'bad type'; }, r => { r.error.httpStatus = 0; },
    r => { r.error.errno = 'ECONNRESET'; }]) {
    const client = new FanqieClient({ pythonExecutable: 'python' }, engine(async () => {
      const result = { ok: false, code: 'URLError', sourceStage: 'search', host: 'api5-normal.fqnovel.com', networkMode: 'direct',
        error: { type: 'URLError', message: 'Connection failed' } };
      change(result);
      return result;
    }));
    assert.equal((await client.call('search', { query: '书' }, root)).code, 'engine_failed');
    await client.dispose();
  }
});

test('preserves input failures that occur before an engine request starts', async t => {
  const root = await workspace(t);
  const client = new FanqieClient({ pythonExecutable: 'python' }, engine(async () => ({
    ok: false, complete: false, code: 'input_size',
    error: { type: 'EngineError', reasonType: 'EngineError', message: '工具输入超过大小限制。' },
  })));
  t.after(() => client.dispose());
  const result = await client.call('search', { query: '书'.repeat(24_000) }, root);
  assert.equal(result.code, 'input_size');
  assert.equal(result.networkMode, 'direct');
  assert.equal(result.sourceStage, undefined);
  assert.equal(result.host, undefined);
  assert.equal(result.error.type, 'EngineError');
  assert.match(result.message, /输入超过大小限制/u);
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
