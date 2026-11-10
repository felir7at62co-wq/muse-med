/** Load current product resources through the default or actual creation Skill tool. */
import assert from 'node:assert/strict'
import { cp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'

const files = await importSnapshotPackage('@deepseek-ai/dsh-skill-filesystem',
  new URL('../../../apps/cli/package.json', import.meta.url))
const { renderSkillContent } = await importSnapshotPackage('@deepseek-ai/dsh-skill',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))
const productRoot = fileURLToPath(new URL('../../../apps/desktop-host/skills/', import.meta.url))
const skillName = 'video-to-screenplay'

export const name = 'snapshot-video-screenplay-entry'
export const inject = ['skills', 'llm', 'agents', 'tools', 'systemPrompt', 'workingDirectory', 'agentPresets']

/** Mount the maintained resources and compare complete tool output with the actual registry. */
export async function apply(ctx, config) {
  const root = join(process.cwd(), '.dsh', 'product-video-skills')
  await cp(productRoot, root, { recursive: true })
  await ctx.plugin(files, { includeDefaultRoots: false, includeProjectRoots: false, bundledSkillDir: root, watch: false }).await()
  if (config.creation === true) await mountPreset(ctx, { presetId: 'creation', hidePlatformShellTools: true })
  const reference = 'references/video-workflow.md'
  let requests = 0, calls = 0
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/call') {
      assert.equal(event.data.name, config.creation === true ? 'run_code' : 'skill')
      calls++
    }
    if (event.type === 'turn/end') {
      assert.equal(event.data.reason.kind, 'completed')
      assert.equal(requests, 2)
      assert.equal(calls, 1)
    }
  })
  ctx.on('llm/stream', async function* (options, next) {
    const agent = ctx.agents.get(options.sessionId)
    assert.ok(agent)
    const original = await ctx.skills.get(skillName, { cwd: process.cwd() })
    assert.ok(original)
    assert.equal(original.source, 'bundled')
    assert.deepEqual(original.resourceBase, { kind: 'directory', path: join(root, skillName) })
    assert.ok(original.content.length > 0)
    const current = config.creation === true ? ctx.agentPresets.serviceFor(agent, 'skills') : ctx.skills
    assert.ok(current)
    if (config.creation === true) assert.notEqual(current, ctx.skills)
    const skill = await current.get(skillName, { scope: agent, cwd: process.cwd() })
    assert.ok(skill)
    assert.equal(skill.content, original.content)
    assert.deepEqual(skill.resourceBase, original.resourceBase)
    assert.equal(skill.provider, config.creation === true ? 'muse-creation' : original.provider)
    const entries = options.messages.flatMap(message => message.source?.kind === 'skill-catalog' ? message.source.entries : [])
    assert.ok(entries.some(entry => entry.name === skillName))
    assert.ok(!entries.some(entry => entry.name === 'transcript-to-script'))
    assert.deepEqual(await readFile(join(skill.resourceBase.path, reference)),
      await readFile(join(productRoot, skillName, reference)))
    if (requests === 1) {
      const results = options.messages.filter(message => message.role === 'tool')
      assert.equal(results.length, 1)
      assert.equal(results[0].isError, false, 'The actual Skill invocation must return the maintained entry')
      const text = results[0].content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (config.creation === true) {
        const value = JSON.parse(text)
        assert.equal(value.name, skillName)
        assert.equal(value.provider, 'muse-creation')
        assert.equal(value.content, original.content)
        assert.deepEqual(value.resourceBase, original.resourceBase)
      } else assert.equal(text, renderSkillContent(original))
    }
    requests++
    yield* next()
  })
}
