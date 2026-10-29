/** Verify a streamed read continues within a line and delivers the reconstructed text. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const host = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const present = await importSnapshotPackage('@deepseek-ai/dsh-tool-present', host)
export const name = 'read-long-line-fixture'
export const inject = ['tools', 'fs']
const sha = text => createHash('sha256').update(text).digest('hex')

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped headless profile context. */
export async function apply(ctx) {
  await ctx.plugin(present)
  ctx.effect(() => {
    const resolve = ctx.fs.resolve.bind(ctx.fs)
    const stat = ctx.fs.stat.bind(ctx.fs)
    ctx.fs.resolve = async (path, options) => {
      const target = await resolve(path, options)
      return path === 'source.txt' ? { ...target, displayPath: 'source.txt' } : target
    }
    ctx.fs.stat = async (target, signal) => {
      const info = await stat(target, signal)
      return info && target.displayPath === 'source.txt' ? { ...info, version: 'fixture-version' } : info
    }
    return () => { ctx.fs.resolve = resolve; ctx.fs.stat = stat }
  })
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('long-line snapshot refuses network') }
    return () => { globalThis.fetch = original }
  })
  ctx.on('agent/created', async ({ agent }) => {
    const sourcePath = join(agent.session.header.cwd, 'source.txt')
    const source = await readFile(sourcePath, 'utf8')
    assert.ok(!source.includes('\r'), 'checkout seed must use LF')
    await writeFile(sourcePath, source.replaceAll('\n', '\r\n'))
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const result = id => {
      const event = events.find(item => item.type === 'tool/result' && item.surfaceOp === 'append'
        && item.data.message.toolCallId === id)
      assert.ok(event, `missing ${id}`)
      assert.equal(event.data.message.isError, false, `${id} must succeed`)
      return event.data
    }
    const first = result('call_long_1'), second = result('call_long_2'), third = result('call_long_3')
    assert.deepEqual(first.meta.continuation, { offset: 2, column: 2001 })
    assert.deepEqual(second.meta.continuation, { offset: 2, column: 4001 })
    assert.equal(second.meta.column, 2001)
    assert.equal(third.meta.column, 4001)
    assert.equal(third.meta.continuation, undefined)
    for (const [previous, nextId] of [[first, 'call_long_2'], [second, 'call_long_3']]) {
      const call = events.find(event => event.type === 'tool/call' && event.data.callId === nextId)
      assert.ok(call, `missing ${nextId}`)
      const args = JSON.parse(call.data.arguments)
      assert.equal(args.offset, previous.meta.continuation.offset)
      assert.equal(args.column, previous.meta.continuation.column)
      const text = previous.message.content.find(block => block.type === 'text')?.text ?? ''
      assert.match(text, /Continue with offset=2, column=\d+/u)
      assert.doesNotMatch(text, /End of file/u)
    }
    const lines = [first.meta.lines[0].text, first.meta.lines[1].text + second.meta.lines[0].text
      + third.meta.lines[0].text, third.meta.lines[1].text]
    const reconstructed = `${lines.join('\n')}\n`
    const sourcePath = join(agent.session.header.cwd, 'source.txt')
    const rawSource = await readFile(sourcePath, 'utf8')
    assert.ok(rawSource.includes('\r\n'), 'the actual read must use CRLF')
    assert.ok(!rawSource.replaceAll('\r\n', '').includes('\n'), 'all source newlines must be CRLF')
    const source = rawSource.replaceAll('\r\n', '\n')
    const delivery = await readFile(join(agent.session.header.cwd, 'delivery.txt'), 'utf8')
    assert.equal(sha(reconstructed), sha(source), 'read pages cover the normalized source')
    assert.equal(sha(delivery), sha(source), 'saved delivery matches the normalized source')
    result('call_long_4'); result('call_long_5')
    assert.ok(events.some(event => event.type === 'deliverables/presented'), 'delivery remains available')
    await writeFile(sourcePath, source)
  })
}
