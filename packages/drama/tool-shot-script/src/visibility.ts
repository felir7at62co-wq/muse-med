/** Visible-roster parsing and nonblocking advice for explicit whole-subject offscreen declarations. */
import type { ShotIssue } from './types.ts'

/** Read a field label without treating a repeated inline reference as another identity.
 * @param source - Authored field text, retained separately for reference validation.
 * @returns The explicit plain label, or reference labels when no plain label exists.
 */
export function materialFieldLabel(source: string): string {
  const labels: string[] = []
  const plain = source.replace(/@\[([^\]]+)\]\(([^()\s]+)\)/g, (_match, label: string) => {
    labels.push(label)
    return ''
  }).trim()
  return plain || labels.join('、')
}

/** Split a visible-character list while preserving costume annotations and current inline-reference normalization.
 * @param source - Complete authored visible-character field.
 * @returns Normalized labels in declaration order.
 */
export function declaredCharacters(source: string): string[] {
  const result: string[] = []
  let depth = 0; let current = ''
  for (const character of source) {
    if ('（('.includes(character)) depth++
    if ('）)'.includes(character)) depth = Math.max(0, depth - 1)
    if (depth === 0 && /[、,，;；/|｜\n]/.test(character)) {
      if (current.trim()) result.push(materialFieldLabel(current))
      current = ''
    } else current += character
  }
  if (current.trim()) result.push(materialFieldLabel(current))
  return result
}

/** Position values must begin with an unqualified whole-subject offscreen declaration. */
const OFFSCREEN_POSITION = /^(?:(?:全程|始终)(?:在|位于)?|(?:已)?(?:在|位于))?画外(?:声音来源|声源)?(?=$|[，,；;。.!！：: （(])/u
/** These values do not establish a position. */
const UNCERTAIN_POSITION = /可能|假设|待定|待确认|未确认|未指定|不确定/u
/** Partial visibility or successive positions need source review rather than a whole-shot inference. */
const VISIBILITY_OR_TRANSITION = /入画|入镜|出画|出镜|画内|镜内|画面内|镜头内|进入画面|离开画面|走出画面|走入画面|露出|可见|随后|之后|然后|起初|起先|开始时|最初|前半|后半|从画外|由画外/u
/** A subject's own position header, with bracketed or bare field text. */
const POSITION = /^[ \t]*【[^】\r\n]+】[ \t]*[-－][ \t]*位置[：:][ \t]*(?:【[^】\r\n]*】|[^\r\n]*)/gm

/** Read the subject label of a matched position header. */
const positionName = (header: string): string => header.slice(header.indexOf('【') + 1, header.indexOf('】')).trim()

/**
 * Advise when a named visible subject explicitly stays offscreen without a visible part or staged entry/exit.
 * Voice types, gaze directions and dialogue do not establish visual absence. The original fields remain unchanged.
 * @param block - One complete shot block.
 * @param charactersField - Its explicit visible-character list, or an empty string.
 * @param shot - The shot's declared number.
 * @param firstLine - The block's 1-based line in the complete script.
 * @returns Nonblocking findings at the conflicting position lines.
 */
export function offscreenCharacterIssues(block: string, charactersField: string, shot: number, firstLine: number): ShotIssue[] {
  const visible = new Set(declaredCharacters(charactersField).map(label => label.replace(/[（(].*$/u, '').trim()))
  const positions = [...block.matchAll(POSITION)]
  const camera = block.match(/^[ \t]*运镜[：:].*$/gm)?.join('\n') ?? ''
  const issues: ShotIssue[] = []
  for (const [index, position] of positions.entries()) {
    const header = position[0], name = positionName(header)
    const field = header.slice(header.indexOf('】') + 1)
    const raw = field.slice(field.search(/[：:]/u) + 1).trim()
    const value = raw.startsWith('【') ? raw.slice(1, -1) : raw
    if (!visible.has(name) || !OFFSCREEN_POSITION.test(value) || UNCERTAIN_POSITION.test(value)) continue
    if (positions.some(other => other !== position && positionName(other[0]) === name)) continue
    const section = block.slice(position.index, positions[index + 1]?.index ?? block.length)
    const staging = section.match(/^[ \t]*(?:动作状态|手部状态)[：:].*$/gm)?.join('\n') ?? ''
    if (VISIBILITY_OR_TRANSITION.test(`${value}\n${staging}\n${camera}`)) continue
    const line = firstLine + block.slice(0, position.index).split('\n').length - 1
    issues.push({ severity: 'warning', code: 'offscreen_character_listed', shot, line,
      message: `镜头${shot}（脚本第${line}行）的出镜人物包含「${name}」，但该主体位置明确写为「${value}」。`
        + '请核对本镜实际可见范围；仅画外声源不列入出镜名单，局部可见或镜内进出则明确写出阶段。'
        + '保留原台词与发声方式，可见人物的内心声音仍可使用 vo。' })
  }
  return issues
}
