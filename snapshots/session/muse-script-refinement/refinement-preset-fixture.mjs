/** Check the current product persona and complete professional resources in model requests. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'

const { parse } = createRequire(new URL('../../../apps/desktop-host/package.json', import.meta.url))('yaml')
const skillNames = ['muse-dialogue-polish', 'muse-episode-design', 'muse-script-doctor', 'screenplay-format']
const references = [
  ['muse-dialogue-polish', 'dialogue-workflow.md'],
  ['muse-episode-design', 'episode-workflow.md'],
  ['muse-script-doctor', 'doctor-workflow.md'],
  ['screenplay-format', 'writing-quality.md'],
  ['screenplay-format', 'narrative-layers.md'],
]

export const name = 'snapshot-script-refinement'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'llm', 'skills']

/** Mount the product preset and verify instructions reach each subsequent model request. */
export async function apply(ctx) {
  const rows = parse(await readFile(new URL('../../../apps/desktop-host/presets/short-drama/agent.cordis.yml', import.meta.url), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: value }) }],
  })
  const persona = rows.find(row => row.id === 'persona')?.config?.prefix
  assert.equal(typeof persona, 'string', 'current product persona')
  await mountPreset(ctx, { presetId: 'short-drama', hidePlatformShellTools: true })
  const results = []
  let requests = 0
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/result') {
      assert.equal(event.data.message.isError, false, 'professional resource read succeeds')
      results.push(event.data.message)
    }
    if (event.type === 'turn/end') {
      assert.equal(results.length, skillNames.length + references.length, 'all professional resources read')
      assert.equal(requests, results.length + 1, 'resource results followed by a model request')
    }
  })
  ctx.on('llm/stream', async function* (options, next) {
    const text = options.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
    const system = options.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
    assert.ok(system.includes(persona), 'complete product persona reaches the model')
    for (const result of results) {
      const message = options.messages.find(message => message.role === 'tool' && message.toolCallId === result.toolCallId)
      assert.deepEqual(message?.content, result.content, 'logged resource result reaches the next model request')
    }
    if (results.length === skillNames.length + references.length) {
      for (const name of skillNames) {
        const loaded = await ctx.skills.get(name, { cwd: process.cwd() })
        assert.ok(loaded?.content?.trim(), 'current professional skill is available')
        assert.ok(text.includes(loaded.content.trim()), 'complete current skill instructions reach the model')
      }
      for (const [name, reference] of references) {
        const contents = (await readFile(join(process.cwd(), '.dsh', 'skills', name, 'references', reference), 'utf8')).replaceAll('\r\n', '\n').trimEnd()
        const numbered = contents.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n')
        assert.ok(text.includes(numbered), 'complete current method guide reaches the model')
      }
    }
    requests++
    yield* next()
  })
}
