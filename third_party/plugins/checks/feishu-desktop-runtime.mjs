/** Verify the packaged Muse entry and retained card renderer without external services. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as channel from './lib/index.js'
import * as upstream from './lib/upstream/index.js'

test('keeps the Muse channel disabled until configured without inserting another profile', async () => {
  assert.equal(typeof channel.apply, 'function')
  assert.equal(typeof upstream.apply, 'function')
  assert.ok(channel.Config)
  assert.equal(readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8').trim(), '[]')
  const ctx = new Context()
  try {
    await ctx.plugin(channel, { enabled: false, defaultCwd: process.cwd(), dataDir: process.cwd() })
    assert.equal(ctx.get('feishu'), undefined)
  } finally {
    await ctx.fiber.dispose()
  }
})
