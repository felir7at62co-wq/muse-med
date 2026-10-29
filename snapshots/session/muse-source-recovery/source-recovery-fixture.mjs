/** Assert recorded read recovery through the shipped headless profile. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'

const host = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const recovery = await importSnapshotModule(new URL('../../../apps/desktop-host/src/source-recovery.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/source-recovery.js', import.meta.url))
const present = await importSnapshotPackage('@deepseek-ai/dsh-tool-present', host)
export const name = 'source-recovery-fixture'
export const inject = ['tools', 'fs', 'sessionQuery', 'toolResultPruner']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped-profile context. */
export async function apply(ctx) {
  await ctx.plugin(recovery)
  await ctx.plugin(present)
  ctx.effect(() => {
    // Keep the actual filesystem identity while making this fixture's model-facing source path stable.
    const originalResolve = ctx.fs.resolve.bind(ctx.fs)
    ctx.fs.resolve = async (path, options) => {
      const target = await originalResolve(path, options)
      return path === 'source.txt' ? { ...target, displayPath: 'source.txt' } : target
    }
    return () => { ctx.fs.resolve = originalResolve }
  })
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('source recovery snapshot refuses network') }
    return () => { globalThis.fetch = original }
  })
  let pruned = false
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || pruned) return decision
    const readResult = agent.session.deriveMessages().find(message => message.role === 'tool'
      && message.toolCallId === 'call_recovery_1' && !message.isError)
    if (!readResult) return decision
    const result = ctx.toolResultPruner.pruneSession(agent.session)
    assert.equal(result.pruned.length, 1)
    assert.equal(result.pruned[0].originalSeq, 15, 'authored recovery calls target the original recorded event')
    pruned = true
    return decision
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    assert.ok(pruned, 'actual pruner must replace the read output')
    const events = agent.session.snapshotEvents()
    const result = id => {
      const event = events.find(item => item.type === 'tool/result' && item.surfaceOp === 'append'
        && item.data.message.toolCallId === id)
      assert.ok(event, `missing ${id}`)
      assert.equal(event.data.message.isError, false, `${id} must succeed`)
      return event.data.message.content.find(block => block.type === 'text')?.text
    }
    const raw = result('call_recovery_1')
    const first = JSON.parse(result('call_recovery_2'))
    const second = JSON.parse(result('call_recovery_3'))
    assert.equal(first.next_offset, 100)
    assert.equal(second.offset, 100)
    assert.equal(second.next_offset, null)
    assert.equal(first.text + second.text, raw, 'pages reconstruct the complete recorded tool result')
    assert.equal(first.read_file_scope, 'complete')
    assert.equal(first.recorded_result, 'original_logged_event_not_verified_complete')
    assert.ok(events.some(event => event.type === 'compaction/prune'))
    const index = agent.session.deriveMessages().find(message => message.role === 'user'
      && message.source.kind === 'muse-manuscript' && message.content.some(block => block.type === 'text'
        && block.text.startsWith('{"source_recovery":')))
    assert.ok(index, 'recovery index enters the logged model context')
    assert.ok(!events.some(event => event.type === 'system/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text.includes('source_recover'))),
    'source recovery adds no system prompt section')
    result('call_recovery_4'); result('call_recovery_5')
    assert.equal(await readFile(join(agent.session.header.cwd, 'delivery.txt'), 'utf8'), '已核对并完成。\n')
    assert.ok(events.some(event => event.type === 'deliverables/presented'), 'delivery remains available')
  })
}
