/** Literal prompt findings for model review; no mutation or execution decision. */
import { JubianError } from '@deepseek-ai/dsh-jubian'

/** Deployment-owned terms and output bounds for advisory prompt review. */
export interface PromptRiskReviewConfig {
  /** Exact terms to find, including inside quotes and negative instructions. */
  terms: string[]
  /** Unicode characters on each side of a match; defaults to 24, range 0..200. */
  contextChars?: number
  /** Maximum findings returned across all addressed cards; defaults to 100, range 1..1000. */
  maxMatches?: number
}

/** Validated review settings, absent when the deployment has no term list. */
export interface PromptRiskReviewOptions {
  readonly terms: readonly string[]
  readonly contextChars: number
  readonly maxMatches: number
}

/**
 * Validate advisory review configuration before registering the tools.
 * @param config - Optional deployment term list and result bounds.
 * @returns Resolved settings, or undefined when review is unconfigured.
 */
export function resolvePromptRiskReview(config?: PromptRiskReviewConfig): PromptRiskReviewOptions | undefined {
  if (config === undefined) return undefined
  const value: unknown = config
  if (value === null || typeof value !== 'object' || !('terms' in value)
    || !Array.isArray(value.terms) || !value.terms.length
    || value.terms.some(term => typeof term !== 'string' || !term.trim() || term !== term.trim())
    || new Set(value.terms).size !== value.terms.length) {
    throw new JubianError('INVALID_ARGUMENT', 'promptRiskReview.terms must contain distinct nonempty trimmed strings')
  }
  const contextChars = config.contextChars ?? 24
  const maxMatches = config.maxMatches ?? 100
  if (!Number.isSafeInteger(contextChars) || contextChars < 0 || contextChars > 200
    || !Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > 1000) {
    throw new JubianError('INVALID_ARGUMENT', 'promptRiskReview requires contextChars 0..200 and maxMatches 1..1000')
  }
  return { terms: [...config.terms], contextChars, maxMatches }
}

/**
 * Find literal terms in complete saved or proposed prompts without exempting quoted text.
 * @param cards - Addressed cards and their actual proposed or saved prompts.
 * @param options - Validated deployment settings; undefined leaves the result unchanged.
 * @returns An optional advisory field; offsets use UTF-16 units and text is never rewritten.
 */
export function promptRiskReview(cards: readonly {
  storyboard_id: number
  card_name: string | null
  prompt: string
}[], options: PromptRiskReviewOptions | undefined): Record<string, unknown> {
  if (options === undefined) return {}
  const matches: { storyboard_id: number; card_name: string | null; term: string; offset: number; context: string }[] = []
  let totalMatches = 0
  for (const card of cards) {
    for (const term of options.terms) {
      let offset = card.prompt.indexOf(term)
      while (offset !== -1) {
        totalMatches++
        if (matches.length < options.maxMatches) {
          const before = options.contextChars === 0 ? ''
            : Array.from(card.prompt.slice(0, offset)).slice(-options.contextChars).join('')
          const after = Array.from(card.prompt.slice(offset + term.length)).slice(0, options.contextChars).join('')
          matches.push({ storyboard_id: card.storyboard_id, card_name: card.card_name, term, offset,
            context: before + term + after })
        }
        offset = card.prompt.indexOf(term, offset + 1)
      }
    }
  }
  return { prompt_risk_review: { mode: 'advisory', total_matches: totalMatches,
    matches, truncated: totalMatches > matches.length,
    next: '以下为配置词表的字面命中提示，不是自动违规判定，也不拦截保存或生成。未命中不代表完整审核通过。'
      + '逐处对照来源，不凭引号认定原台词；自行补写的描述、否定句、负面提示和备注中的禁用词应删去或改为符合剧情的正向描述。'
      + '核实为剧本原台词时，首次逐字保留；生成失败且确认原因与该词有关后，才最小修改对应词语，禁止改写整段台词。'
      + '修正后重新预览、保存并核对逐卡真实回读；生成前对已保存卡重新 prepare_video，保留未改动请求的原幂等 key。'
      + (totalMatches > matches.length ? '命中明细已截断，须结合完整提示词继续核对未展示位置。' : '') } }
}
