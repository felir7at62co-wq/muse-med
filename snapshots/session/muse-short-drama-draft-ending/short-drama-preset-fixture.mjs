/** Verify the assembled short-drama prompt through the actual preset. */
import assert from 'node:assert/strict'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'

export const name = 'snapshot-short-drama-draft-ending'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'llm', 'permissionPresets']

/** Mount the product preset and check the prompt sent to the replay model. */
export async function apply(ctx) {
  await mountPreset(ctx, { presetId: 'short-drama', hidePlatformShellTools: true })
  ctx.on('agent/created', ({ agent }) => {
    assert.equal(ctx.permissionPresets.current(agent.session), 'danger-full-access', 'new Muse session uses Full access')
  })
  let requests = 0
  ctx.on('llm/stream', async function* (options, next) {
    const system = options.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
      .join('\n')
    assert.ok(system.includes('你是 muse-med 短剧编导 Agent，由 deepseek-flash 驱动。\n\n'), 'short-drama identity')
    assert.ok(system.includes('Seedance 2.0 的视频时长上限为15秒，Seedance 2.5 为30秒'), 'current model durations')
    assert.ok(system.includes('不按已有卡片数量、固定镜头数或固定秒数机械分包'), 'content determines package planning')
    assert.ok(system.includes('内容分包完成后，再映射到剧变视频卡'), 'plan content before assigning cards')
    assert.ok(system.includes('需要几包就填写几张，多余空卡保留不用'), 'unused cards may remain empty')
    assert.ok(system.includes('后续镜头再次提及同一资产时继续内联引用'), 'each shot references its used assets inline')
    assert.ok(system.includes('不能只在包首集中列一排素材代替正文引用'), 'header lists do not replace inline references')
    assert.ok(system.includes('不为补齐引用而新增、补生成资产或站位图'), 'reference checks do not create assets')
    assert.ok(system.includes('站位图是当前视频包的空间关系参考图'), 'positioning reference definition')
    assert.ok(system.includes('视频包固定自检清单'), 'persistent package checklist')
    assert.ok(system.includes('最终回复提供可核对证据'), 'delivery evidence required')
    assert.ok(system.includes('引用与选材绑定一致，不编造key'), 'references match real selected assets')
    assert.ok(!system.includes('支持30秒的模型可以一次生成完整的30秒视频段落'), 'removed package-duration wording')
    assert.ok(!system.includes('预置8张空卡'), 'no fixed card-count example')
    assert.ok(!system.includes('不把预先规划当成效果已经达标的证明'), 'removed post-generation wording')
    assert.ok(system.includes('不是视频包时长上限，也不是每包只能3–4镜'), 'shot rhythm differs from package length')
    assert.ok(system.includes('场景、在场主体和相对位置基本稳定时，考虑使用已有的合适站位图'), 'positioning image criteria')
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
