/** Replay editable draft ending guidance through the actual short-drama preset. */
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
    for (const rule of [
      'project_bible.visual_medium 为准，style 原文独立保留',
      'animation_3d 的成片与剪映草稿都不新增任何水印或片尾',
      '不删除或遮盖源素材已有的第三方标记',
      'photorealistic 的成片与剪映草稿保留右下角全程纯白无描边「内容由AI生成」，覆盖正文和片尾定格，右上角不加水印',
      '草稿保留可编辑独立文字轨',
      '仅仿真人和未确认类型的旧项目保留片尾 2 秒，用最后一镜真实尾帧定格',
      '草稿保留可编辑独立定格片段',
      '禁止同号分镜PNG替代',
      '抽帧与 framemd5 比对按技能执行，不一致就重抽、仍失败即停止',
      '定格保持 2 秒，片尾音只取前 2 秒',
      '特效按自身原速播放一次，余下为纯定格，不变速或拉伸',
      '旧项目未注明 visual_medium 时明确告警并沿用原片尾/水印',
      '时间线与项目类型冲突先解决，不静默覆盖',
      '交付可编辑草稿与成片两份',
    ]) assert.ok(system.includes(rule), 'The actual short-drama model request contains: ' + rule)
    assert.equal(system.includes('右上角与草稿都不加水印'), false,
      'The retired instruction cannot contradict the editable draft watermark')
    assert.ok(options.tools.some(tool => tool.name === 'drama_render'))
    assert.ok(options.tools.some(tool => tool.name === 'drama_shot'))
    requests++
    yield* next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') assert.equal(requests, 1)
  })
}
