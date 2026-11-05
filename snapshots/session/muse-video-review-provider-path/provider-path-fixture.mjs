/** Real provider paths and saved video selectors through the shipped Headless Loader. */
import assert from 'node:assert/strict'
import { mkdir, readFile, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Loader plugin identity. */
export const name = 'snapshot-video-provider-path'
/** Services used by source selection and durable-result assertions. */
export const inject = ['tools', 'fs', 'subprocess', 'sandboxPolicy']

/** Prepare distinct real sources and assert the model's actual tool results.
 * @param ctx - Loader context with the real filesystem and video review plugin.
 */
export function apply(ctx) {
  let physical, root, removed = false, probes = 0
  const originalResolve = ctx.fs.resolve.bind(ctx.fs)
  const originalSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.effect(() => {
    ctx.fs.resolve = (path, options) => {
      if (removed) assert.ok(!path.includes('fixture.mp4'), 'Saved-ID reads must not resolve the missing source')
      return originalResolve(path, options)
    }
    ctx.subprocess.spawn = spec => {
      if (spec.argv[0] === 'ffprobe') {
        assert.ok(spec.argv.includes(physical), 'Probe the physical source, not its lexical sibling')
        probes++
      }
      return originalSpawn(spec)
    }
    return () => { ctx.fs.resolve = originalResolve; ctx.subprocess.spawn = originalSpawn }
  })
  ctx.on('agent/created', async ({ agent }) => {
    root = ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot
    physical = join(root, 'physical', 'fixture.mp4')
    await mkdir(join(root, 'physical', 'nested'), { recursive: true })
    await writeFile(physical, 'requested physical video\n')
    await writeFile(join(root, 'fixture.mp4'), 'wrong lexical sibling\n')
    await symlink('physical/nested', join(root, 'link'), 'dir')
    assert.notDeepEqual(await readFile(physical), await readFile(join(root, 'fixture.mp4')))
    const target = await ctx.fs.resolve(physical, { cwd: root })
    const info = await ctx.fs.stat(target)
    assert.ok(info)
    // A legal saved review models a resumed Session; selectors must not require a rescan.
    agent.session.append('video/review', { kind: 'start', review: {
      id: 'provider-path-review', path: physical, episode: '47', source_version: info.version,
      duration: 4, scanned_until: 4, scan_complete: true,
      frames: [{ id: 'F00001', time: 0, reasons: ['continuity'], exposed: false }],
    } })
  })
  ctx.tools.register(defineTool({ name: 'snapshot_remove_video_source', description: 'Remove this scenario source after checking its selectors.',
    parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { await unlink(physical); removed = true; return 'Fixture source removed.' },
  }))
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const messages = events.filter(event => event.type === 'tool/result').map(event => event.data.message)
    assert.equal(messages.length, 7)
    assert.deepEqual(messages.map(message => Boolean(message.isError)), [false, false, true, false, false, false, false])
    const value = index => JSON.parse(messages[index].content.find(block => block.type === 'text').text)
    assert.equal(value(0).path, physical)
    assert.equal(value(1).path, physical)
    assert.match(messages[2].content.find(block => block.type === 'text').text, /VIDEO_REVIEW_SELECTOR/)
    for (const index of [3, 5, 6]) assert.equal(value(index).follow_up.status, 'closed')
    for (const index of [1, 3, 5, 6]) { assert.equal(value(index).pending, 1); assert.equal(value(index).complete, false) }
    assert.equal(probes, 1)
    assert.equal(removed, true)
    await assert.rejects(readFile(physical), { code: 'ENOENT' })
    assert.deepEqual(events.filter(event => event.type === 'assistant/message').at(-1).data.message.content,
      [{ type: 'text', text: 'PROVIDER PATH VERIFIED' }])
    // Only the fixture's link and empty source directories are removed; the sibling remains in the workspace oracle.
    await unlink(join(root, 'link'))
    await rmdir(join(root, 'physical', 'nested'))
    await rmdir(join(root, 'physical'))
  })
}
