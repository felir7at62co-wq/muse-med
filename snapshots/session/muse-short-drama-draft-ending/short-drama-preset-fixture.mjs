/** Verify the assembled short-drama prompt through the actual preset. */
import assert from 'node:assert/strict'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'

export const name = 'snapshot-short-drama-draft-ending'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'llm']

/** Mount the product preset and check the prompt sent to the replay model. */
export async function apply(ctx) {
  await mountPreset(ctx, { presetId: 'short-drama', hidePlatformShellTools: true })
  let requests = 0
  ctx.on('llm/stream', async function* (options, next) {
    const system = options.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
      .join('\n')
    assert.ok(system.includes('你是 muse-med 短剧编导 Agent，由 deepseek-flash 驱动。\n\n'), 'short-drama identity')
    assert.ok(system.includes('Seedance 2.0 的视频时长上限为15秒，Seedance 2.5 为30秒'), 'current model durations')
    assert.ok(system.includes('支持30秒的模型可以一次生成完整的30秒视频段落'), 'full supported package duration')
    assert.ok(system.includes('不默认缩成10–14秒或15秒'), 'no speculative short-package default')
    assert.ok(system.includes('不是视频包时长上限，也不是每包只能3–4镜'), 'shot rhythm differs from package length')
    assert.ok(system.includes('是否需要站位图辅助控制空间关系'), 'optional positioning image')
    assert.ok(system.includes('角色资产图固定为16:9横版、白底'), 'character asset layout')
    assert.ok(system.includes('人物面部同样不写“脸红”“面部发红”'), 'facial colour wording')
    assert.ok(system.includes('Use the read tool'), 'filesystem guidance')
    assert.ok(system.includes('Track every background job id'), 'background-job guidance')
    assert.ok(system.includes('；短剧工作间是其中的 short-drama/。'), 'dynamic workspace suffix')
    assert.ok(!system.includes('面部留白为纯白色'), 'no removed asset-board rules')
    assert.ok(options.tools.some(tool => tool.name === 'drama_render'), 'render tool retained')
    assert.ok(!options.tools.some(tool => tool.name === 'drama_shot'), 'compiler tool absent')
    for (const name of ['subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'exit_plan_mode']) {
      assert.ok(!options.tools.some(tool => tool.name === name), name + ' absent from unified Agent')
    }
    assert.ok(!system.includes('Use the workflow tool'), 'workflow instructions absent')
    assert.ok(!system.includes('Start independent subagent'), 'delegation instructions absent')
    requests++
    yield* next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') assert.equal(requests, 1)
  })
}
