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
      '成片与剪映草稿都在右下角全程显示纯白无描边「内容由AI生成」，覆盖正文和片尾定格，右上角不加水印',
      '草稿保留可编辑的独立文字轨',
      '成片与剪映草稿的片尾 2 秒都用最后一镜真实尾帧定格',
      '草稿保留可编辑的独立定格片段',
      '禁止同号分镜PNG替代',
      '抽帧与 framemd5 比对按技能执行，不一致就重抽、仍失败即停止',
      '片尾音频、特效与定格严格等长，特效只播放一次',
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
