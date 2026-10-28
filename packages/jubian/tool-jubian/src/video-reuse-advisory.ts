/** Logged, non-blocking advice for requests to extract or reuse existing media. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Existing-media extraction advice; readers preserve it as ordinary context.
     * @persistenceAttribution
     */
    'jubian-video-reuse': { kind: 'jubian-video-reuse' } & ContextFormed
  }
}

const ADVICE = '已有视频提取／复用提示：按本次项目、原卡或原任务核对已有产物；'
  + '可用 jubian_video sources（script_id、storyboard_id）读取已核实来源，再用 jubian_media download 下载后提取。'
  + '保留原 task_id、result_id 与文件来源；旧模型或分辨率不同的视频也可能适合提取声线。'
  + '查询不完整或身份未核时保持未知，不能由本页未找到推断从未生成。'
  + '提取、复用或缺少声线本身不代表新增视频生成授权；另有明确制作要求时按该范围处理。此提示不拦截工具调用。'

function asksForMediaReuse(text: string): boolean {
  // Applicability only: these matches never grant or withhold tool permission.
  return text.split(/[。！？；\n,，!?;]+/u).some((clause) => {
    if (!/视频|成片|原片|声线|音频|声音|\b(?:videos?|footage|voices?|audio)\b/iu.test(clause)) return false
    const action = /提取|抽取|截取|裁出|取样|截出|复用|\b(?:extract|sample|reuse)\b/iu.exec(clause)
    if (action === null) return false
    const before = clause.slice(0, action.index)
    return !/(?:不(?:要|用|需(?:要)?|必|能)?|无需|禁止|别|\bdo\s+not\b|\bdon't\b)[^。！？；\n,，!?;]*$/iu.test(before)
  })
}

/**
 * Append one notice after a newly admitted human request to extract or reuse media.
 * The notice enters the normal user-message log and does not reject steps, run
 * tools, change parameters, or retain intent across later user requests.
 * @param ctx - Plugin context owning the reversible pre-step listener.
 * @returns Disposer for the listener; context disposal also removes it.
 */
export function registerVideoReuseAdvisory(ctx: Context): () => void {
  return ctx.on('agent/pre-step', async ({ signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const humanIndex = decision.messages.findLastIndex(message => message.source.kind === 'user')
    const human = decision.messages[humanIndex]
    if (decision.messages.slice(humanIndex + 1).some(message => message.source.kind === 'jubian-video-reuse')) {
      return decision
    }
    const text = human?.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    if (text === undefined || !asksForMediaReuse(text)) return decision
    return { ...decision, messages: [...decision.messages, createUserMessage({
      content: [{ type: 'text', text: ADVICE }],
      source: { kind: 'jubian-video-reuse', form: 'notice', summary: '已有视频提取与复用提示' },
    })] }
  })
}
