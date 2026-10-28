/** Literal dialogue parsing and project guidance candidates. */
import { basename } from 'node:path'

interface Location { path: string; scene: string; episode: string; line: number; quote: string }
interface Dialogue extends Location { speaker: string; voice: string; parentheticals: string[]; text: string }
interface UserText { message_id: string; text: string }
interface GuidanceFinding {
  kind: string
  line: number
  quote: string
  restriction: string
  user_basis: string
  literal_user_mentions: { message_id: string; quote: string }[]
  literal_user_mentions_omitted: number
}
interface GuidanceCandidates {
  advisory: boolean
  path: string
  attribution: string
  scope: string
  findings: GuidanceFinding[]
  total: number
  omitted: number
  authority_assessment: string
  notice: string
}

/**
 * Parse a screenplay dialogue label while preserving its exact line and parentheticals.
 * @param location - Current manuscript location and unmodified line.
 * @returns A syntactically recognized speech line, without judging speaker identity or performance.
 */
export function manuscriptDialogue(location: Location): Dialogue | undefined {
  const match = /^\s*([^：:\n]+)[：:]\s*(.+)$/u.exec(location.quote)
  if (!match?.[1] || !match[2]) return undefined
  const parentheticals = [...match[1].matchAll(/[（(]([^（）()]*)[）)]/gu)].map(entry => entry[1] ?? '')
  const speaker = match[1].replace(/[（(][^（）()]*[）)]/gu, '').replace(/\b(?:OS|VO)\b/gu, '').trim()
  if (!/^[\p{L}][\p{L}\p{N}·・\s]*$/u.test(speaker) || ['人物', '场景', '地点', '时间'].includes(speaker)) return undefined
  const voices = [...new Set([...match[1].matchAll(/\b(OS|VO)\b/gu)].map(entry => entry[1]))]
  return { ...location, speaker, voice: voices.sort().join('+') || 'dialogue', parentheticals, text: match[2] }
}

const restrictions = [
  { kind: 'dialogue_merge_prohibition', pattern: /(?:不(?:要)?合并|禁止合并)(?:连续)?(?:台词|对白)/u },
  { kind: 'mandatory_parentheticals', pattern: /每(?:一)?(?:句|行)(?:台词|对白)[^。；\n]*(?:必须|都要|一律)[^。；\n]*(?:括注|括号)/u },
  { kind: 'fixed_parenthetical_template', pattern: /对白[：:]\s*`?人物名[（(]括注[）)][：:]台词/u },
] as const

/** @param path - Tool-reported project file path. @returns Whether its basename is a recognized guidance filename. */
export function isManuscriptGuidancePath(path: string): boolean {
  return /^(?:写作规范|创作规范|项目规范|编写规范|writing[-_]guidelines|project[-_]guidelines)\.(?:md|txt)$/iu.test(basename(path))
}

function guidanceCandidates(path: string, lines: readonly { number: number; text: string }[], users: readonly UserText[],
  maximumFindings: number, attribution: string, scope: string): GuidanceCandidates | undefined {
  if (!isManuscriptGuidancePath(path)) return undefined
  const findings: GuidanceFinding[] = []
  let total = 0
  for (const { number, text: quote } of lines) {
    for (const { kind, pattern } of restrictions) {
      const restriction = pattern.exec(quote)?.[0]
      if (!restriction) continue
      total++
      if (findings.length >= maximumFindings) continue
      const mentions = users.flatMap(user => user.text.split('\n').filter(line => line.includes(restriction))
        .map(line => ({ message_id: user.message_id, quote: line })))
      findings.push({ kind, line: number, quote, restriction,
        user_basis: mentions.length ? 'literal_user_text_found' : 'no_literal_user_text_found',
        literal_user_mentions: mentions.slice(0, maximumFindings),
        literal_user_mentions_omitted: Math.max(0, mentions.length - maximumFindings) })
    }
  }
  if (!total) return undefined
  return { advisory: true, path, attribution, scope, findings, total,
    omitted: total - findings.length, authority_assessment: 'not_performed',
    notice: '项目文件里的规范不自动成为用户新增要求。no_literal_user_text_found只表示未找到逐字依据，不等于与用户冲突；找到引用也不证明授权。结合用户实际要求判断，不从自行编写的规范追加限制；不阻止写入或交付。' }
}

/**
 * Identify newly written literal restrictions in recognized project-guidance files, without granting them authority.
 * @param mutation - Successful write/edit result containing exact before/after text.
 * @param users - Actual logged human-message text; quotations are possible mentions, not interpreted authorization.
 * @param maximumFindings - Maximum returned restriction candidates.
 * @returns Model-tool attribution and literal user references, absent when the scoped write adds no candidate.
 */
export function manuscriptGuidanceCandidates(mutation: { path: string; before: string | null; after: string },
  users: readonly UserText[], maximumFindings: number): GuidanceCandidates | undefined {
  const oldLines = new Map<string, number>()
  for (const line of (mutation.before ?? '').split('\n')) oldLines.set(line, (oldLines.get(line) ?? 0) + 1)
  const added: { number: number; text: string }[] = []
  for (const [index, line] of mutation.after.split('\n').entries()) {
    const oldCount = oldLines.get(line) ?? 0
    if (oldCount > 0) { oldLines.set(line, oldCount - 1); continue }
    added.push({ number: index + 1, text: line })
  }
  return guidanceCandidates(mutation.path, added, users, maximumFindings, 'current_model_tool_mutation', 'newly_written_lines_only')
}

/**
 * Inspect only guidance lines already returned by a successful read, without rereading or inferring authorship.
 * @param read - Tool-returned path and numbered text; omitted or truncated content is not reconstructed.
 * @param users - Actual logged human-message text, kept separate from document statements.
 * @param maximumFindings - Maximum candidates and literal user references per candidate.
 * @returns Scoped, nonblocking restriction candidates, absent when no returned line matches.
 */
export function manuscriptReadGuidanceCandidates(read: { path: string; lines: { number: number; text: string }[] },
  users: readonly UserText[], maximumFindings: number): GuidanceCandidates | undefined {
  return guidanceCandidates(read.path, read.lines, users, maximumFindings, 'document_read_authorship_unknown', 'tool_returned_lines_only')
}
