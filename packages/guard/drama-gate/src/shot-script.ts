/**
 * Structural checks for shot scripts and matched JSON written through file tools.
 * Creative pacing and voice guidance is reported by `drama_shot`, not refused here.
 * @module @deepseek-ai/dsh-guard-drama/src/shot-script
 */

/** Han, Latin letters, and digits used by the advisory speech estimate. */
const EFFECTIVE_CHARACTER = /[\u4e00-\u9fffA-Za-z0-9]/g

/**
 * Count effective characters without changing the spoken text.
 * @param text - Spoken text.
 * @returns Han characters, Latin letters and digits counted.
 */
export function countEffectiveChars(text: string): number {
  return text.match(EFFECTIVE_CHARACTER)?.length ?? 0
}

/**
 * Estimate whole seconds at nine effective characters per second; not a duration requirement.
 * @param effectiveChars - Effective character count.
 * @returns Estimated seconds, at least one.
 */
export function requiredSeconds(effectiveChars: number): number {
  return Math.max(1, Math.ceil(effectiveChars / 9))
}

/**
 * Reject malformed explicit durations; omitted durations are derived by the compiler.
 * @param text - Complete shot-script text.
 * @returns Structural failure guidance, or undefined.
 */
export function checkShotScriptText(text: string): string | undefined {
  for (const match of text.matchAll(/^[ \t]*时长[：:][ \t]*(.*?)[ \t]*$/gm)) {
    const declared = match[1] ?? ''
    if (!/^[1-9]\d*秒$/.test(declared) || !Number.isSafeInteger(Number(declared.slice(0, -1)))) {
      return `时长「${declared}」不合法：明确声明时长时必须是正整数秒，例如「时长：20秒」；也可省略，由 drama_shot 估算。`
    }
  }
  return undefined
}

/**
 * Reject malformed matched JSON or non-positive/non-integer shot durations.
 * Provider limits are checked when compiling with an explicit package budget and before submission.
 * @param text - Complete matched/package JSON text.
 * @returns Structural failure guidance, or undefined.
 */
export function checkMatchedJsonText(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'matched JSON 不是合法 JSON；请修复语法后重写。'
  }
  const shots = Array.isArray(parsed) ? parsed : record(parsed)?.['shots']
  if (!Array.isArray(shots)) return 'matched JSON 必须有 shots 数组。'
  for (const entry of shots) {
    const shot = record(entry)
    if (shot === undefined) return 'matched JSON 的每个镜头必须是对象。'
    const duration = shot['script_duration'] ?? shot['duration']
    if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 1) {
      return 'matched JSON 的镜头时长必须是正整数秒；请修正 script_duration/duration。'
    }
    if (shot['text'] !== undefined && typeof shot['text'] !== 'string') {
      return 'matched JSON 的台词 text 必须是字符串，保留原文。'
    }
  }
  return undefined
}

/** Narrow parsed JSON to a record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
