/** Explicitly enabled real-source qualification using the Host's built subprocess provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FanqieClient } from '../src/client.js';

test('finds real books by title and resolves a search candidate through the complete catalog', {
  skip: !process.env.MUSE_FANQIE_LIVE_QUERY,
  timeout: 30 * 60_000,
}, async () => {
  const { Context } = await import('../../../../vendor/cordis/lib/index.js');
  const { default: SubprocessLocal } = await import('../../../../packages/subprocess/subprocess-local/lib/index.js');
  const ctx = new Context(), workspace = await mkdtemp(join(tmpdir(), 'muse-fanqie-search-live-'));
  let client;
  try {
    await ctx.plugin(SubprocessLocal);
    client = new FanqieClient({ pythonExecutable: process.env.MUSE_FANQIE_PYTHON_PATH ?? '' }, ctx.subprocess);
    const query = process.env.MUSE_FANQIE_LIVE_QUERY;
    const result = await client.call('search', { query }, workspace);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.complete, false);
    const selected = result.items.find(book => book.title === query);
    assert.ok(selected, 'The explicitly selected title must appear in official results');
    const info = await client.call('info', { bookIds: [selected.bookId] }, workspace);
    assert.equal(info.ok, true, JSON.stringify(info));
    assert.equal(info.items[0].bookId, selected.bookId);
    assert.equal(info.items[0].chapterCount, info.items[0].chapters.length);
    if (result.hasMore) {
      const next = await client.call('search', { query, passback: result.nextPassback }, workspace);
      assert.equal(next.ok, true, JSON.stringify(next));
      assert.equal(next.complete, false);
      assert.notDeepEqual(next.items.map(book => book.bookId), result.items.map(book => book.bookId),
        'The next-page cursor must advance the official search results');
    }
  } finally {
    await client?.dispose();
    await ctx.fiber.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('downloads every published chapter of the explicitly selected real books', {
  skip: !process.env.MUSE_FANQIE_LIVE_BOOK_IDS,
  timeout: 30 * 60_000,
}, async () => {
  const { Context } = await import('../../../../vendor/cordis/lib/index.js');
  const { default: SubprocessLocal } = await import('../../../../packages/subprocess/subprocess-local/lib/index.js');
  const ctx = new Context(), workspace = await mkdtemp(join(tmpdir(), 'muse-fanqie-live-'));
  let client;
  try {
    await ctx.plugin(SubprocessLocal);
    client = new FanqieClient({ pythonExecutable: process.env.MUSE_FANQIE_PYTHON_PATH ?? '' }, ctx.subprocess);
    const bookIds = process.env.MUSE_FANQIE_LIVE_BOOK_IDS.split(',');
    const result = await client.call('download', { bookIds }, workspace);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.complete, true);
    assert.equal(result.items.length, bookIds.length);
    for (const item of result.items) {
      assert.equal(item.downloadedChapters, item.chapterCount);
      assert.equal(item.chapters.length, item.chapterCount);
      assert.equal(createHash('sha256').update(await readFile(item.file)).digest('hex'), item.sha256);
    }
  } finally {
    await client?.dispose();
    await ctx.fiber.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});
