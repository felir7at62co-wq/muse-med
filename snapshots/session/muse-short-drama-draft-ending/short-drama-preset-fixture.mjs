/** Verify the assembled short-drama prompt through the actual preset. */
import assert from 'node:assert/strict'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const Jubian = await importSnapshotModule(
  new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url),
)

export const name = 'snapshot-short-drama-draft-ending'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'llm', 'permissionPresets', 'credentials', 'sessionProjections']

/** Mount the product preset and check the prompt sent to the replay model. */
export async function apply(ctx) {
  await ctx.plugin(Jubian, {
    workspaceSecrets: false,
    sessionVideoSelection: true,
    defaultVideoModel: { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', resolution: '480p' },
  }).await()
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
    assert.ok(system.includes('时长在所选模型能力内'), 'current model determines package duration')
    assert.ok(!system.includes('Seedance 2.0 的视频时长上限为15秒，Seedance 2.5 为30秒'), 'no fixed model duration table')
    assert.ok(system.includes('不因提示词长、镜头多、固定秒数或已有空卡数量机械拆包'), 'content determines package planning')
    assert.ok(system.includes('先决定内容、时长和包数，再填写已有视频卡'), 'plan content before assigning cards')
    assert.ok(system.includes('多余空卡不用，卡不足才新增'), 'unused cards may remain empty')
    assert.ok(system.includes('后续镜头再次提及同一资产时继续内联引用'), 'each shot references its used assets inline')
    assert.ok(system.includes('不能只在包首集中列一排素材代替正文引用'), 'header lists do not replace inline references')
    assert.ok(system.includes('不为补齐引用而新增、补生成资产或站位图'), 'reference checks do not create assets')
    assert.ok(system.includes('站位图展示各主体唯一位置、相对距离、遮挡、视线和固定环境锚点'), 'positioning reference definition')
    assert.ok(system.includes('视频包固定自检清单'), 'persistent package checklist')
    assert.ok(system.includes('最终回复提供可核对证据'), 'delivery evidence required')
    assert.ok(system.includes('引用与选材绑定一致，不编造key'), 'references match real selected assets')
    assert.ok(!system.includes('支持30秒的模型可以一次生成完整的30秒视频段落'), 'removed package-duration wording')
    assert.ok(!system.includes('预置8张空卡'), 'no fixed card-count example')
    assert.ok(!system.includes('不把预先规划当成效果已经达标的证明'), 'removed post-generation wording')
    assert.ok(system.includes('不是视频包时长上限，也不限制每包镜头数量'), 'shot rhythm differs from package length')
    assert.ok(system.includes('本包场景与在场主体及相对位置基本稳定时，考虑使用已有合适站位图'), 'positioning image criteria')
    assert.ok(system.includes('人物角色资产图：16:9横版白底'), 'character asset layout')
    assert.ok(system.includes('完整保留头部、发型和双脚'), 'complete character views')
    assert.ok(system.includes('仅将右侧可见脸部覆盖为纯白'), 'white face cover only')
    assert.ok(system.includes('背面保留后脑与发型'), 'back-view hair retained')
    assert.ok(system.includes('严禁无头、截头'), 'no head crop')
    assert.ok(!system.includes('不强套横版拼贴和三视图'), 'specified views are required')
    assert.ok(system.includes('人物面部同样不写“脸红”“面部发红”'), 'facial colour wording')
    assert.ok(system.includes('Use the read tool'), 'filesystem guidance')
    assert.ok(system.includes('Track every background job id'), 'background-job guidance')
    assert.ok(system.includes('；短剧工作间是其中的 short-drama/。'), 'dynamic workspace suffix')
    assert.ok(!system.includes('面部留白为纯白色'), 'no removed asset-board rules')
    assert.ok(options.tools.some(tool => tool.name === 'drama_render'), 'render tool retained')
    const shotReview = options.tools.find(tool => tool.name === 'drama_shot')
    assert.ok(shotReview, 'shot review tool retained')
    assert.ok(shotReview.description.includes('问题均作 warning'), 'shot review remains advisory')
    assert.ok(shotReview.description.includes('不硬拦截、不要求清零'), 'shot review does not block creative choices')
    const videoModel = options.tools.find(tool => tool.name === 'jubian_video_model')
    assert.ok(videoModel?.description.includes('选择后追加上下文'), 'session video model changes remain visible')
    assert.ok(options.messages.some(message => message.source?.kind === 'runtime-context'
      && message.content.some(block => block.type === 'text'
        && block.text.includes('本会话默认视频模型为 doubao-seedance-2-5-260628，分辨率 480p。'))),
    'Desktop video defaults reach the model through runtime context')
    for (const name of ['subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents']) {
      assert.ok(options.tools.some(tool => tool.name === name), name + ' available for delegated work')
    }
    for (const name of ['workflow', 'exit_plan_mode']) {
      assert.ok(!options.tools.some(tool => tool.name === name), name + ' absent from unified Agent')
    }
    assert.ok(!system.includes('Use the workflow tool'), 'workflow instructions absent')
    requests++
    yield* next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') assert.equal(requests, 1)
  })
}
