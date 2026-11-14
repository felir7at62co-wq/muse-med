/** Advisory review of explicit shot-plan declarations in actual prepared text, never generated pixels. */
import { continuityPeriod } from './quality.ts'
import type { ParsedShot, ShotIssue } from './types.ts'

/** Deployment choices for declared empty-shot budgets and repeated shot plans. */
export interface PreparedPlanPolicy {
  /** Maximum suggested content seconds for an explicitly pure-environment insert without source justification. */
  emptyShotMaxSeconds: number
  /** Consecutive explicitly matching plans needed before an advisory repetition finding. */
  repetitiveShotThreshold: number
}

const FIELDS = ['镜头类型', '景别', '主运镜', '视线目标', '情绪触发', '空镜用途',
  '空镜超时依据', '眼部特效依据', '镜头设计依据'] as const
const PLACEHOLDER = /^(?:无|未知|待补|待定|同上|略|TODO)$/iu
const declaredValue = (value: string): string => value.trim().replace(/[；;]\s*$/u, '').trim().replace(/^【(.*)】$/u, '$1').trim()
const substantive = (value: string | null): value is string => value !== null && value.length > 0 && !PLACEHOLDER.test(value)
const sourceBasis = (value: string | null): boolean => {
  const citation = value === null ? null : /^(?:原文|剧本)[：:](.*)$/u.exec(value)
  return citation !== null && substantive(declaredValue(citation[0].replace(/^[^：:]+[：:]/u, '')))
}

/** Explicit fields and their original lines; absent or repeated declarations stay unknown. */
export type PreparedShotDeclaration = {
  shot: number
  line: number
  duration_seconds: number
  duration_source: ParsedShot['durationSource']
  fields: Record<typeof FIELDS[number], { value: string; line: number } | null>
}

function eyeLight(body: string): boolean {
  return body.split(/[，,；;。.!！?？\n]|但是|但|而是|却/u).some((clause) => {
    if (/(?:禁止|避免|不得|不能|不要|不再|没有|并非|不应|不准|不许|无|不).*(?:瞳孔|眼球|眼睛|双眼)/u.test(clause)) return false
    const eyes = /(?:瞳孔|眼球|眼睛|双眼)(.*)/u.exec(clause)?.[1]
    if (eyes === undefined || /^(?:[^发泛亮闪射冒]*)(?:不|无|没有|并非|避免|禁止)/u.test(eyes)) return false
    if (/(?:自发光|射出[^\s]*光束|激光)/u.test(eyes)) return true
    if (/(?:反射|反光|倒映|映照|高光|泪光)/u.test(eyes)) return false
    return /(?:发光|(?:泛起|泛出|发出|冒出|亮起|闪烁)?(?:蓝白光|红光|蓝光|金光|微光|暗光))/u.test(eyes)
  })
}

/** Review only written declarations, retaining unknown values and source-text line locations.
 * @param prompt - Actual prepared director prompt, unchanged by this review.
 * @param shots - Parsed prepared shots and their reviewed or estimated content times.
 * @param policy - Deployment-owned advisory limits.
 * @returns Declared values and non-blocking findings; no source truth or media acceptance is inferred.
 */
export function reviewPreparedPlan(prompt: string, shots: readonly ParsedShot[], policy: PreparedPlanPolicy): {
  declarations: PreparedShotDeclaration[]
  issues: ShotIssue[]
} {
  const lines = prompt.split('\n'), issues: ShotIssue[] = []
  const entries = shots.map((shot, index) => {
    const nextLine = shots[index + 1]?.line
    const body = lines.slice(shot.line - 1, nextLine === undefined ? lines.length : nextLine - 1)
    const fields = Object.fromEntries(FIELDS.map((name) => {
      const matches = body.flatMap((row, offset) => {
        const match = new RegExp(`^${name}[：:](.*)$`, 'u').exec(row.trim())
        return match === null ? [] : [{ value: declaredValue(row.trim().slice(name.length + 1)), line: shot.line + offset }]
      })
      const [first, ...rest] = matches
      if (first !== undefined && rest.length > 0) {
        issues.push({ code: 'prepared_declaration_ambiguous', severity: 'warning', shot: shot.shot, line: first.line,
          message: `镜头${shot.shot}重复声明「${name}」，本次保留为未知；核对实际提交内容，未自动选择或补写。` })
        return [name, null]
      }
      return [name, first ?? null]
    })) as PreparedShotDeclaration['fields']
    const value = (name: typeof FIELDS[number]) => fields[name]?.value ?? null
    const insert = fields['镜头类型']
    if (insert !== null && ['纯环境空镜', '环境空镜'].includes(insert.value) && shot.voiceType === 'action'
      && shot.durationSeconds > policy.emptyShotMaxSeconds && !sourceBasis(value('空镜超时依据'))) {
      issues.push({ code: 'prepared_empty_shot_over_budget', severity: 'warning', shot: shot.shot,
        line: insert.line,
        message: `镜头${shot.shot}明确为环境空镜，内容预算${shot.durationSeconds}秒超过建议${policy.emptyShotMaxSeconds}秒，缺少「原文：…」或「剧本：…」超时依据；核对空镜用途与实际节奏，不裁掉必要动作或按API最短提交秒数改预算。` })
    }
    const directions = body.filter(row => /^(?:动作状态|情绪状态|四层朝向链|运镜|眼部表现|视觉特效)[：:]/u.test(row.trim()))
    if (directions.some(eyeLight) && !sourceBasis(value('眼部特效依据'))) {
      issues.push({ code: 'prepared_eye_light_directive', severity: 'warning', shot: shot.shot,
        line: shot.line + body.findIndex(row => directions.includes(row) && eyeLight(row)),
        message: `镜头${shot.shot}的画面指令含眼球或瞳孔发光，缺少「原文：…」或「剧本：…」特效依据；核对题材与原文，普通反射和眼神情绪不等于眼部自发光。本项只检查计划文字，不检测成片像素。` })
    }
    return { declaration: { shot: shot.shot, line: shot.line, duration_seconds: shot.durationSeconds,
      duration_source: shot.durationSource, fields }, scene: shot.sceneField, period: continuityPeriod(shot) }
  })
  for (const [field, accepted, code] of [
    ['景别', ['特写', '大特写'], 'prepared_repetitive_framing'],
    ['主运镜', ['固定', '固定机位', '固定镜头'], 'prepared_repetitive_camera'],
  ] as const) {
    let run: typeof entries = []
    const flush = () => {
      const [first] = run
      if (first === undefined || run.length < policy.repetitiveShotThreshold
        || run.some(entry => substantive(entry.declaration.fields['镜头设计依据']?.value ?? null))) return
      const start = first.declaration, end = run.reduce((_previous, entry) => entry, first).declaration
      issues.push({ code, severity: 'warning', shot: end.shot, line: end.line,
        message: `镜头${start.shot}–${end.shot}在同场连续${run.length}镜明确使用${field === '景别' ? '特写' : '固定机位'}，未声明镜头设计依据；核对叙事用途与节奏，不推定长镜头或固定机位必然错误，不自动补运镜。` })
    }
    let previous: typeof entries[number] | undefined
    for (const entry of entries) {
      const value = entry.declaration.fields[field]?.value
      const sameScene = previous !== undefined && previous.scene === entry.scene && previous.period === entry.period
      previous = entry
      if (!entry.scene || value === undefined || !accepted.some(item => item === value)) { flush(); run = []; continue }
      if (!sameScene) { flush(); run = [] }
      run.push(entry)
    }
    flush()
  }
  return { declarations: entries.map(entry => entry.declaration), issues }
}
