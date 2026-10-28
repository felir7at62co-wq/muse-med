/** Replay project-owned historical guides alongside available media and Wiki tools. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const Jubian = await importSnapshotModule(new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url))
export const name = 'snapshot-creation-preset'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'skills', 'llm', 'agents', 'credentials']
/** Mount the product preset and verify explicitly seeded project guides remain available. */
export async function apply(ctx) {
  await ctx.plugin(Jubian, { baseUrl: 'https://snapshot-jubian.invalid', workspaceSecrets: false }).await()
  await mountPreset(ctx, { presetId: 'creation', hidePlatformShellTools: true })
  let requests = 0
  ctx.on('llm/stream', async function* (options, next) {
    assert.deepEqual(options.tools.map(tool => tool.name), ['run_code'])
    const agent = ctx.agents.get(options.sessionId)
    assert.ok(agent)
    const results = options.messages.filter(message => message.role === 'tool')
    assert.equal(results.length, requests)
    const names = ['screenplay-project', 'video-review', 'screenplay-format']
    for (let index = 0; index < Math.min(requests, names.length); index++) {
      const result = results[index]
      if (index === 0 || index === 2) {
        assert.equal(result.isError, false, 'The recorded probe returns the project-owned guide')
        const value = JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join(''))
        const skill = await ctx.skills.get(names[index], { scope: agent, cwd: agent.session.header.cwd })
        assert.ok(skill)
        assert.equal(value.available, true)
        assert.equal(value.skill.name, names[index])
        assert.equal(value.skill.content, skill.content)
        assert.deepEqual(value.skill.resourceBase, {
          kind: 'directory', path: join(agent.session.header.cwd, '.dsh', 'skills', names[index]),
        })
        const entries = options.messages.flatMap(message => message.source?.kind === 'skill-catalog' ? message.source.entries : [])
        assert.ok(entries.some(skill => skill.name === names[index]), `Project guide ${names[index]} must remain in the model catalog`)
        continue
      }
      assert.equal(result.isError, false, 'The media guide remains available')
      const value = JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      const skill = await ctx.skills.get(names[index], { scope: agent, cwd: agent.session.header.cwd })
      assert.ok(skill)
      assert.equal(value.content, skill.content)
      assert.deepEqual(value.resourceBase, skill.resourceBase)
    }
    if (requests === 4) {
      const value = JSON.parse(results[3].content.filter(block => block.type === 'text').map(block => block.text).join(''))
      const wiki = await ctx.skills.get('muse-llm-wiki', { scope: agent, cwd: agent.session.header.cwd })
      assert.ok(wiki)
      assert.equal(value.wiki.content, wiki.content)
      assert.deepEqual(value.wiki.resourceBase, wiki.resourceBase)
      assert.equal(value.wiki.provider, 'muse-creation')
      assert.ok(value.wiki.content.includes('读取参数不包含 `count` 或 `limit`'))
      assert.ok(value.writing.lines.length > 0, 'Explicit reads of a historical workspace reference still return its text')
      assert.equal(value.writing.lines.length, value.writing.totalLines)
    }
    requests++
    yield* next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') assert.equal(requests, 5)
  })
}
