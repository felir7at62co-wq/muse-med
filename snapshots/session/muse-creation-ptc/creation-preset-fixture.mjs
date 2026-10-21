/** Replay the real PTC skill binding with technical resources and minimal manuscript guidance. */
import assert from 'node:assert/strict'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
export const name = 'snapshot-creation-preset'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'skills', 'llm', 'agents']
/** Mount the current preset and inspect actual model-visible inputs. */
export async function apply(ctx) {
  await mountPreset(ctx, { presetId: 'creation', hidePlatformShellTools: true })
  let requests = 0
  ctx.on('llm/stream', async function* (options, next) {
    assert.deepEqual(options.tools.map(tool => tool.name), ['run_code'])
    const system = options.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.ok(system.includes('分场剧本采用用户指定的格式'))
    assert.ok(system.includes('manuscript_revision'))
    assert.ok(!system.includes('下一模型轮检查'))
    assert.ok(!system.includes('\n  screenplay_project:'))
    const entries = options.messages.flatMap(message => message.source?.kind === 'skill-catalog' ? message.source.entries : [])
    for (const name of ['muse-dialogue-polish', 'muse-script-doctor', 'muse-episode-design', 'screenplay-format']) {
      assert.ok(!entries.some(skill => skill.name === name))
    }
    assert.ok(entries.some(skill => skill.name === 'audio-transcribe'))
    if (requests === 1) {
      const result = options.messages.find(message => message.role === 'tool')
      assert.equal(result.isError, false)
      const value = JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      assert.equal(value.name, 'audio-transcribe')
      assert.ok(value.content.includes('音视频语音转写'))
      assert.ok(value.resourceBase)
    }
    requests++
    yield* next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') assert.equal(requests, 2)
  })
}
