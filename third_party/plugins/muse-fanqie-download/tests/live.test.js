/** Explicitly enabled real-source qualification using the Host's built subprocess provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FanqieClient } from '../src/client.js';

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
