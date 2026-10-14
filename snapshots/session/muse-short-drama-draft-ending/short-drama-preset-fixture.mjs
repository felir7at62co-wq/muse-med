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
      'project_bible.visual_medium',
      '不从“写实 3D”等风格词或画幅推断',
      'animation_3d 的成片与剪映草稿都不新增任何水印或片尾',
      '不创建水印文字轨、定格片尾轨或片尾音效轨，也不要求片尾素材',
      'photorealistic 的成片与剪映草稿保留右下角全程纯白无描边「内容由AI生成」',
      '草稿保留可编辑独立文字轨',
      '仅仿真人和未确认类型的旧项目保留片尾 2 秒，用最后一镜真实尾帧定格',
      '草稿保留可编辑独立定格片段',
      '禁止同号分镜PNG替代',
      '抽帧与 framemd5 比对按技能执行，不一致就重抽、仍失败即停止',
      '定格保持 2 秒，片尾音只取前 2 秒',
      '特效按自身原速播放一次，余下为纯定格，不变速或拉伸',
      '旧项目未注明 visual_medium 时明确告警并沿用原片尾/水印',
      '交付可编辑草稿与成片两份',
    ]) assert.ok(system.includes(rule), 'The actual short-drama model request contains: ' + rule)
    assert.equal(system.includes('右上角与草稿都不加水印'), false,
      'The retired instruction cannot contradict the editable draft watermark')
    assert.equal(system.includes('成片与剪映草稿都在右下角全程显示'), false,
      'The retired unconditional watermark rule cannot contradict animation delivery')
    assert.equal(system.includes('片尾音频、特效与定格严格等长'), false,
      'The native-rate effect must not be stretched to the ending duration')
    assert.ok(options.tools.some(tool => tool.name === 'drama_render'))
    assert.ok(options.tools.some(tool => tool.name === 'drama_shot'))
    requests++
    yield* next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') assert.equal(requests, 1)
  })
}
