/** Verify the assembled short-drama prompt through the actual preset. */
import assert from 'node:assert/strict'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const Jingliu = await importSnapshotModule(
  new URL('../../../packages/drama/tool-jingliu/src/index.ts', import.meta.url),
  new URL('../../../packages/drama/tool-jingliu/lib/index.js', import.meta.url),
)

export const name = 'snapshot-short-drama-draft-ending'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'llm', 'permissionPresets', 'credentials', 'sessionProjections']

/** Mount the product preset and check the prompt sent to the replay model. */
export async function apply(ctx) {
  ctx.effect(() => ctx.provide('jingliuConnection', { async connection() { throw new Error('Catalog-only snapshot') } }))
  await ctx.plugin(Jingliu).await()
  await mountPreset(ctx, { presetId: 'short-drama', hidePlatformShellTools: true })
  ctx.on('agent/created', ({ agent }) => {
    assert.equal(ctx.permissionPresets.current(agent.session), 'danger-full-access', 'new Muse session uses Full access')
  })
  let requests = 0
  ctx.on('llm/stream', async function* (options, next) {
    const system = options.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
      .join('\n')
    assert.ok(system.includes('你是 muse-med 短剧编导 Agent。\n\n'), 'short-drama identity')
    assert.ok(system.includes('符合当前模型实际时长范围'), 'model-specific component durations')
    assert.ok(system.includes('不因提示词长、镜头多、固定秒数机械拆包'), 'content determines package planning')
    assert.ok(system.includes('查询 get_prompt_rules 和 preview_prompt'), 'use Jingliu project prompt rules')
    assert.ok(system.includes('改动原稿须取得用户同意'), 'a refused generation cannot silently alter source')
    assert.ok(system.includes('用户只要预览时展示内容后停止'), 'preview remains read-only')
    assert.ok(system.includes('每镜按实际出镜的人物、场景、道具和声音核对参考'), 'shot-specific references')
    assert.ok(system.includes('切到对方反应时，延续说话人的声音和动作方向'), 'continuity across a reaction shot')
    assert.ok(system.includes('用 get_shot 回读镜头最终保存的提示词'), 'verify real shot state')
    assert.ok(system.includes('只给已有成稿绑定素材时加载 muse-bind-existing-assets'), 'existing manuscript binding routes to its own skill')
    assert.ok(system.includes('站位图仅适用于场景固定、在场人物固定、人物位置保持不变的视频包'), 'positioning image criteria')
    assert.ok(system.includes('人物素材未指定版式时，默认使用16:9横版白底设定板'), 'default character sheet layout')
    assert.ok(system.includes('本轮用户明确要求单画面全身图、单视图或人物立绘时，只展示一个完整、面容可见的人物'), 'explicit single-view layout')
    assert.ok(system.includes('项目风格中的旧版式文字不覆盖本轮明确要求'), 'current layout overrides older project defaults')
    assert.ok(!system.includes('人物角色资产图：16:9横版白底'), 'character sheets are conditional')
    assert.ok(system.includes('完整保留头部、发型和双脚'), 'complete character views')
    assert.ok(system.includes('四个独立区域从左到右依次为同一人物的正脸胸像、正面（0°）全身、严格侧面（90°）全身、背面（180°）全身'), 'bust and three distinct views')
    assert.ok(system.includes('左侧胸像正面平视，完整显示头顶、发型、清晰五官、肩部和上胸，不遮罩'), 'front bust remains unmasked')
    assert.ok(system.includes('纯白遮罩仅贴合右侧正面和侧面的脸部轮廓，不盖头发、耳部、颈部或衣领'), 'white face cover only')
    assert.ok(system.includes('背面完整呈现后脑、发型、颈部和服装，不加任何遮罩或白块'), 'back-view hair retained without a mask')
    assert.ok(system.includes('不能省略侧面、以正背两视图替代三视图或用四分之三面替代严格侧面'), 'strict side view cannot be omitted')
    assert.ok(system.includes('严禁无头、截头'), 'no head crop')
    assert.ok(!system.includes('不强套横版拼贴和三视图'), 'specified views are required')
    assert.ok(system.includes('人物面部同样不写“脸红”“面部发红”'), 'facial colour wording')
    assert.ok(system.includes('Use the read tool'), 'filesystem guidance')
    assert.ok(system.includes('Track every background job id'), 'background-job guidance')
    assert.ok(system.includes('短剧工作间是当前工作目录中的 short-drama/。'), 'dynamic workspace suffix')
    assert.ok(!system.includes('面部留白为纯白色'), 'no removed asset-board rules')
    assert.ok(options.tools.some(tool => tool.name === 'drama_render'), 'render tool retained')
    const shotReview = options.tools.find(tool => tool.name === 'drama_shot')
    assert.ok(shotReview, 'shot review tool retained')
    assert.ok(shotReview.description.includes('问题均作 warning'), 'shot review remains advisory')
    assert.ok(shotReview.description.includes('不硬拦截、不要求清零'), 'shot review does not block creative choices')
    for (const name of ['jingliu_workflows', 'jingliu_run', 'jingliu_narration', 'muse_billing']) {
      assert.ok(options.tools.some(tool => tool.name === name), name + ' available through Muse')
    }
    assert.ok(!options.tools.some(tool => tool.name.startsWith('jubian_')), 'retired tool names are absent')
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
