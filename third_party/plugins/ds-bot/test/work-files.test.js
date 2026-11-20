// Muse: the panel's file tree lists one level of a conversation's working folder.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1, workspaceId: 'w1', mainBotIds: ['m1'], revision: 2,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', instructions: '', createdAt: 1 } },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
}

function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-files-'))
  const work = join(home, 'work')
  mkdirSync(join(work, 'scripts'), { recursive: true })
  mkdirSync(join(work, '.muse'))
  writeFileSync(join(work, 'cast.md'), 'cast')
  writeFileSync(join(work, 'scripts', 'ep6.md'), 'episode 6')
  writeFileSync(join(home, 'outside.txt'), 'not the Bot\'s')
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  Object.assign(ctx, { workspaceRegistry: { get: id => (id === 'w1' ? { id, path: work } : undefined), resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} } })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  return { rt, stop: async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } }
}

test('a level lists folders first, without hidden entries, and a subfolder by its path', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  await rt.load()
  const top = await rt.workFiles('m1', '')
  assert.equal(top.name, 'work')
  assert.equal(top.path, '')
  assert.deepEqual(top.entries, [{ name: 'scripts', dir: true }, { name: 'cast.md', dir: false }])
  assert.equal(top.truncated, false)
  const scripts = await rt.workFiles('m1', 'scripts')
  assert.equal(scripts.path, 'scripts')
  assert.deepEqual(scripts.entries, [{ name: 'ep6.md', dir: false }])
})

test('a path that leaves the working folder, or a conversation outside the team, is refused', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  await rt.load()
  await assert.rejects(rt.workFiles('m1', '..'), /outside the working folder/)
  await assert.rejects(rt.workFiles('m1', '/'), /outside the working folder/)
  await assert.rejects(rt.workFiles('stranger', ''), /not part of your Bot team/)
})
