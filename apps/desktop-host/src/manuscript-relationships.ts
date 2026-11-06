/** Source-anchored character identities and directed, model-authored relationship notes. */
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import type { ManuscriptDocument } from './manuscript-document.ts'
import { manuscriptReadingText } from './manuscript-reading.ts'
import { indexManuscriptSource, manuscriptSourceLineLabels, manuscriptSourceRangeContext,
  type ManuscriptSourceLineLabel, type ManuscriptSourceRangeContext } from './manuscript-source-context.ts'

/** Stable identity within the explicitly selected manuscript task. */
export type ManuscriptCharacterId = Branded<'ManuscriptCharacterId'>
/** Stable identity of one directed relationship note. */
export type ManuscriptRelationshipId = Branded<'ManuscriptRelationshipId'>

const text = z.string().trim().min(1)
const characterId = text.transform(brandString<ManuscriptCharacterId>)
const quote = z.string().refine(value => value.trim().length > 0, '原句不能为空。')

/** Exact selected reading lines after shared-reader newline display; the digest identifies the unchanged source bytes. */
export const manuscriptSourceEvidenceSchema = z.strictObject({
  source_path: z.string().min(1), source_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  start_line: z.number().int().min(1), end_line: z.number().int().min(1), quote,
})

/** Explicit character labels supported by actual source passages; aliases do not establish semantic truth. */
export const manuscriptCharacterSchema = z.strictObject({
  character_id: characterId, name: text, aliases: z.array(text).optional(),
  evidence: z.array(manuscriptSourceEvidenceSchema).min(1),
})

/**
 * A relation describes the subject's role toward the object, without implying its inverse or truth.
 * Scope and status retain the model's interpretation; contextual names never become global aliases.
 */
export const manuscriptRelationshipSchema = z.strictObject({
  relationship_id: text.transform(brandString<ManuscriptRelationshipId>),
  subject_id: characterId, object_id: characterId, relation: text,
  status: z.enum(['asserted', 'uncertain', 'contradicted']),
  scope: z.strictObject({ episode: text.optional(), scene_id: text.optional(), story_time: text.optional(), context: text }),
  contextual_name: z.strictObject({ term: text, speaker_id: characterId, target_id: characterId }).optional(),
  evidence: z.array(manuscriptSourceEvidenceSchema).min(1),
})

/** Canonical source identity and exact reading-line citation. */
export type ManuscriptSourceEvidence = z.infer<typeof manuscriptSourceEvidenceSchema>
/** Source-supported labels for one explicit stable character identity. */
export type ManuscriptCharacter = z.infer<typeof manuscriptCharacterSchema>
/** Model-authored relationship, retaining direction, narrative scope and uncertainty. */
export type ManuscriptRelationship = z.infer<typeof manuscriptRelationshipSchema>

/** Exact quotation or heading supporting the supplied time text, without establishing its semantic scope. */
export interface ManuscriptRelationshipTimeBasis {
  kind: 'quote' | 'episode_heading' | 'scene_heading'
  start_line: number
  end_line: number
  quote: string
  value: string
}

/** Current citation locations, separate from the model-authored relationship's validity or event state. */
export interface ManuscriptRelationshipSourceContext extends ManuscriptSourceRangeContext {
  source_path: string
  source_sha256: string
  time_basis: ManuscriptRelationshipTimeBasis[]
  line_labels: ManuscriptSourceLineLabel[]
  notice: string
}

/** A saved scope needs rereading when its explicit location or time has no current source support. */
export interface ManuscriptRelationshipScopeIssue {
  field: 'evidence' | 'episode' | 'scene_id' | 'story_time' | 'context' | 'contextual_name'
  code: 'source_unavailable' | 'range_unavailable' | 'quote_mismatch' | 'unassigned' | 'mismatch'
    | 'unsupported_time' | 'structured_scope_required' | 'term_not_in_body'
    | 'speaker_unresolved' | 'speaker_ambiguous' | 'speaker_mismatch'
  message: string
}

/**
 * Recover actual citation sections and literal time occurrences without inferring when an event happened.
 * @param anchor - Canonical current-source quotation and inclusive line range.
 * @param sources - Complete currently bound source documents.
 * @param storyTime - Optional exact text to locate in the quotation or its actual titles.
 * @returns Actual sections and literal time occurrences; no event occurrence or validity period is certified.
 * @throws Error when the source, range or quotation does not match the current document.
 */
export function manuscriptEvidenceContext(anchor: ManuscriptSourceEvidence, sources: readonly ManuscriptDocument[],
  storyTime?: string): ManuscriptRelationshipSourceContext {
  const source = sources.find(row => row.path === anchor.source_path && row.sha256 === anchor.source_sha256)
  if (!source) throw Error('MANUSCRIPT_RELATION_SCOPE_SOURCE: 来源版本不可用，先回读当前来源。')
  const lines = manuscriptReadingText(source.text).split('\n'), index = indexManuscriptSource(source.text)
  if (anchor.end_line < anchor.start_line || anchor.end_line > index.total_lines) {
    throw Error('MANUSCRIPT_RELATION_SCOPE_LINES: 引用范围不在当前来源中。')
  }
  const quote = lines.slice(anchor.start_line - 1, anchor.end_line).join('\n')
  if (quote !== anchor.quote) throw Error('MANUSCRIPT_RELATION_SCOPE_QUOTE: 当前来源原句与已存引用不一致。')
  const context = manuscriptSourceRangeContext(index, anchor.start_line, anchor.end_line)
  const time_basis: ManuscriptRelationshipTimeBasis[] = []
  if (storyTime && quote.includes(storyTime)) {
    time_basis.push({ kind: 'quote', start_line: anchor.start_line, end_line: anchor.end_line, quote, value: storyTime })
  }
  const seen = new Set<string>()
  if (storyTime) for (const section of context.sections) {
    for (const [kind, heading] of [['episode_heading', section.episode_heading], ['scene_heading', section.scene_heading]] as const) {
      if (!heading?.text.includes(storyTime) || seen.has(`${kind}:${heading.line}`)) continue
      seen.add(`${kind}:${heading.line}`)
      time_basis.push({ kind, start_line: heading.line, end_line: heading.line, quote: heading.text, value: storyTime })
    }
  }
  return { source_path: source.path, source_sha256: source.sha256, ...context, time_basis,
    line_labels: manuscriptSourceLineLabels(source.text, anchor.start_line, anchor.end_line),
    notice: '这些标题与位置仅说明引文出处，不自动说明关系有效期或事件已发生；时间依据只支持所列原文。' }
}

/**
 * Derive source locations from current quoted lines, without persisting another copy of the source index.
 * @param note - Relationship with canonical, current source citations.
 * @param sources - Current bound source documents.
 * @returns Exact section locations and any literal basis for the supplied story time.
 * @throws When a source version, line range or quotation is unavailable; recheck those notes before projection.
 */
export function manuscriptRelationshipSourceContexts(note: ManuscriptRelationship,
  sources: readonly ManuscriptDocument[]): ManuscriptRelationshipSourceContext[] {
  return note.evidence.map(anchor => manuscriptEvidenceContext(anchor, sources, note.scope.story_time))
}

function contextLocation(context: ManuscriptRelationshipSourceContext): string {
  const headings = context.sections.map(section => `集=${section.episode_label ?? section.episode}，`
    + `场=${section.scene_id ?? '未标明'}，标题行=${section.heading_line ?? '无'}，标题=${JSON.stringify(section.heading)}`)
  return `source_path=${JSON.stringify(context.source_path)}，引用行=${context.start_line}-${context.end_line}，${headings.join('；')}`
}

/**
 * Identify unsupported explicit scope in new or previously saved relationship notes.
 * @param note - Model-authored note whose current citation locations must be checked.
 * @param sources - Bound source documents; absent or changed evidence is reported for rereading.
 * @returns Issues without changing model-authored notes or source contents. Omitted scope fields do not establish unknown locations.
 */
export function manuscriptRelationshipScopeIssues(note: ManuscriptRelationship,
  sources: readonly ManuscriptDocument[]): ManuscriptRelationshipScopeIssue[] {
  const issues: ManuscriptRelationshipScopeIssue[] = [], contexts: ManuscriptRelationshipSourceContext[] = []
  for (const anchor of note.evidence) {
    const source = sources.find(row => row.path === anchor.source_path && row.sha256 === anchor.source_sha256)
    if (!source) {
      issues.push({ field: 'evidence', code: 'source_unavailable',
        message: `source_path=${JSON.stringify(anchor.source_path)}，引用行=${anchor.start_line}-${anchor.end_line}：来源版本不可用。` })
      continue
    }
    const lines = manuscriptReadingText(source.text).split('\n'), index = indexManuscriptSource(source.text)
    if (anchor.end_line < anchor.start_line || anchor.end_line > index.total_lines) {
      issues.push({ field: 'evidence', code: 'range_unavailable',
        message: `source_path=${JSON.stringify(source.path)}，引用行=${anchor.start_line}-${anchor.end_line}：范围不在当前来源中。` })
      continue
    }
    if (lines.slice(anchor.start_line - 1, anchor.end_line).join('\n') !== anchor.quote) {
      issues.push({ field: 'evidence', code: 'quote_mismatch',
        message: `source_path=${JSON.stringify(source.path)}，引用行=${anchor.start_line}-${anchor.end_line}：原句与当前来源不一致。` })
      continue
    }
    contexts.push(manuscriptEvidenceContext(anchor, sources, note.scope.story_time))
  }
  for (const context of contexts) for (const section of context.sections) {
    const episode = note.scope.episode, scene = note.scope.scene_id
    if (episode && (section.episode_basis === 'unassigned'
      || ![section.episode, section.episode_number, section.episode_label].includes(episode))) {
      const unknown = section.episode_basis === 'unassigned'
      issues.push({ field: 'episode', code: unknown ? 'unassigned' : 'mismatch',
        message: `${contextLocation(context)}：scope.episode=${JSON.stringify(episode)}${unknown ? '没有实际集标题依据' : '与引用归属不符'}。` })
    }
    if (scene && scene !== section.scene_id && scene !== section.source_scene_id) {
      issues.push({ field: 'scene_id', code: section.scene_id === null ? 'unassigned' : 'mismatch',
        message: `${contextLocation(context)}：scope.scene_id=${JSON.stringify(scene)}没有对应的来源场景；不能使用采用稿场景ID。` })
    }
  }
  if (note.scope.story_time && !contexts.some(context => context.time_basis.length > 0)) {
    issues.push({ field: 'story_time', code: 'unsupported_time',
      message: `scope.story_time=${JSON.stringify(note.scope.story_time)}须完整逐字出现在所引原句或真实标题中；`
        + `不能自由拼写事件前后时点。${contexts.map(contextLocation).join('；')}` })
  }
  const numberedScope = /第\s*[\d一二三四五六七八九十百千万零〇两]+\s*[集场]|(?:场景|场次)\s*\d+\s*[-—－]\s*\d+|\d{1,2}[:：]\d{2}/u
  if (numberedScope.test(note.scope.context)) {
    issues.push({ field: 'context', code: 'structured_scope_required',
      message: 'scope.context不放具体编号集、场或数字时点；请改用scope.episode、scene_id、story_time并提供当前来源原句。' })
  }
  return issues
}

/**
 * Check a contextual designation against literal source-line labels and unique registered identities.
 * @param note - Directed note whose optional designation identifies a speaker and target.
 * @param sources - Complete current bound sources with unchanged quotations.
 * @param roster - Registered full names and explicit aliases, without inferred identity matches.
 * @returns Mechanical attribution issues; OS and VO labels do not establish audibility or prove the relationship's meaning.
 */
export function manuscriptRelationshipSpeakerIssues(note: ManuscriptRelationship, sources: readonly ManuscriptDocument[],
  roster: readonly ManuscriptCharacter[]): ManuscriptRelationshipScopeIssue[] {
  const designation = note.contextual_name
  if (!designation) return []
  const issue = (code: ManuscriptRelationshipScopeIssue['code'], message: string): ManuscriptRelationshipScopeIssue[] =>
    [{ field: 'contextual_name', code, message }]
  const occurrences: { location: string; speaker: string | null }[] = []
  for (const anchor of note.evidence) {
    const source = sources.find(row => row.path === anchor.source_path && row.sha256 === anchor.source_sha256)
    const lines = source === undefined ? [] : manuscriptReadingText(source.text).split('\n')
    if (source === undefined || anchor.end_line < anchor.start_line || anchor.end_line > indexManuscriptSource(source.text).total_lines
      || lines.slice(anchor.start_line - 1, anchor.end_line).join('\n') !== anchor.quote) {
      return issue('speaker_unresolved', `source_path=${JSON.stringify(anchor.source_path)}，引用行=${anchor.start_line}-${anchor.end_line}：`
        + '没有当前、完整匹配的原句可核对称谓发话标签；先回读来源。')
    }
    for (const label of manuscriptSourceLineLabels(source.text, anchor.start_line, anchor.end_line)) {
      if (label.speech_column === null) continue
      // Labels address the validated range in this same unchanged source text.
      const body = Array.from(lines[label.line - 1] as string).slice(label.speech_column - 1).join('')
      if (body.includes(designation.term)) occurrences.push({
        location: `${source.path}:${label.line}，发话标签=${JSON.stringify(label.speaker_label)}`, speaker: label.speaker_label,
      })
    }
  }
  if (occurrences.length === 0) return issue('term_not_in_body',
    `称谓${JSON.stringify(designation.term)}须出现在所引字面发话行的正文中，不能只在动作、档案、括注或姓名里出现；`
    + '无法定位时可省略contextual_name，保留普通关系与不确定解释。')
  const identities = new Set<ManuscriptCharacterId>()
  for (const occurrence of occurrences) {
    const matches = roster.filter(row => occurrence.speaker !== null
      && [row.name, ...(row.aliases ?? [])].includes(occurrence.speaker))
    if (matches.length === 0) return issue('speaker_unresolved', `${occurrence.location}：没有唯一登记的姓名或别名可对应；不能猜测speaker_id。`)
    if (matches.length > 1) return issue('speaker_ambiguous', `${occurrence.location}：字面标签对应多个角色，请先澄清名册。`)
    for (const match of matches) identities.add(match.character_id)
  }
  if (identities.size > 1) return issue('speaker_ambiguous',
    `称谓${JSON.stringify(designation.term)}在所引正文涉及多个发话人：${occurrences.map(row => row.location).join('；')}。`
    + '请把contextual_name的引文限定到所指发话人，其他关系依据可另引。')
  if (!identities.has(designation.speaker_id)) return issue('speaker_mismatch',
    `${occurrences.map(row => row.location).join('；')}：与contextual_name.speaker_id=${JSON.stringify(designation.speaker_id)}不符。`)
  return []
}

/**
 * Match complete quoted lines to the exact current bound source version.
 * @param evidence - Model-supplied source paths, digests, line ranges and verbatim quotations.
 * @param sources - Current documents selected for this task.
 * @param cwd - Workspace used to resolve relative source paths.
 * @returns Validated citations with canonical source paths; interpretations are unchanged.
 * @throws When a citation names an unbound or stale source, nonexistent lines, or different text.
 */
export async function validateManuscriptEvidence(evidence: readonly ManuscriptSourceEvidence[],
  sources: readonly ManuscriptDocument[], cwd: string): Promise<ManuscriptSourceEvidence[]> {
  return Promise.all(evidence.map(async (entry) => {
    const path = await realpath(resolve(cwd, entry.source_path))
    const source = sources.find(document => document.path === path)
    if (!source) throw Error('MANUSCRIPT_RELATION_SOURCE: 证据必须属于本任务实际登记的来源。')
    if (entry.source_sha256 !== source.sha256) throw Error('MANUSCRIPT_RELATION_STALE: 来源版本已变，重读实际原句后记录。')
    const lines = manuscriptReadingText(source.text).split('\n')
    if (entry.end_line < entry.start_line || entry.end_line > lines.length) {
      throw Error('MANUSCRIPT_RELATION_LINES: 证据行范围不存在。')
    }
    if (lines.slice(entry.start_line - 1, entry.end_line).join('\n') !== entry.quote) {
      throw Error(`MANUSCRIPT_RELATION_QUOTE: source_path=${JSON.stringify(entry.source_path)}，`
        + `start_line=${entry.start_line}，end_line=${entry.end_line}：原句须与指定来源行完整一致，不能用其他位置的同句替代。`
        + `请用read_source，携带source_sha256=${entry.source_sha256}与offset=${entry.start_line}回读该范围，`
        + `按continuation续读到第${entry.end_line}行，再逐字复制所引完整行。`)
    }
    return { ...entry, source_path: source.path }
  }))
}

/**
 * Validate an explicitly supplied roster against bound current sources, without inferring identities.
 * @param raw - Model-authored character rows with stable IDs and source evidence for every name and alias.
 * @param sources - Complete current documents read through the manuscript reader, with canonical paths and file hashes.
 * @param cwd - Workspace used to resolve incoming relative citation paths.
 * @returns Character rows with canonical citation paths; source content remains unchanged.
 */
export async function validateCharacterRoster(raw: unknown, sources: readonly ManuscriptDocument[],
  cwd: string): Promise<ManuscriptCharacter[]> {
  const characters = z.array(manuscriptCharacterSchema).min(1).parse(raw)
  const ids = new Set<ManuscriptCharacterId>(), labels = new Map<string, ManuscriptCharacterId>()
  for (const character of characters) {
    if (ids.has(character.character_id)) throw Error('MANUSCRIPT_CHARACTER_ID: 角色ID不能重复。')
    ids.add(character.character_id)
    for (const label of [character.name, ...(character.aliases ?? [])]) {
      if (labels.has(label) && labels.get(label) !== character.character_id) {
        throw Error('MANUSCRIPT_CHARACTER_ALIAS: 姓名或全局别名对应多个角色；相对称谓应记录具体说话人与所指角色。')
      }
      labels.set(label, character.character_id)
    }
  }
  return Promise.all(characters.map(async (character) => {
    const evidence = await validateManuscriptEvidence(character.evidence, sources, cwd)
    for (const label of [character.name, ...(character.aliases ?? [])]) {
      if (!evidence.some(entry => entry.quote.includes(label))) {
        throw Error(`MANUSCRIPT_CHARACTER_QUOTE: character_id=${JSON.stringify(character.character_id)}，`
          + `label=${JSON.stringify(label)}没有所引原句依据。姓名与每个别名都须出现在该角色所引原句中；工具不猜测同一身份。`)
      }
    }
    return { ...character, evidence }
  }))
}

/**
 * Validate a directed note and its exact evidence, retaining the model's status rather than judging the story.
 * @param raw - Model-authored relationship and optional speaker-relative designation.
 * @param sources - Complete current bound source documents with canonical paths and file hashes.
 * @param roster - Current roster already validated against these sources, never names guessed from the note.
 * @param cwd - Workspace used to resolve incoming relative citation paths.
 * @returns A note with canonical citation paths; no inverse relation, identity merge or truth verdict is generated.
 */
export async function validateManuscriptRelationship(raw: unknown, sources: readonly ManuscriptDocument[],
  roster: readonly ManuscriptCharacter[], cwd: string): Promise<ManuscriptRelationship> {
  const note = manuscriptRelationshipSchema.parse(raw)
  const ids = new Set(roster.map(character => character.character_id))
  const referenced = [note.subject_id, note.object_id, ...(note.contextual_name
    ? [note.contextual_name.speaker_id, note.contextual_name.target_id] : [])]
  if (referenced.some(id => !ids.has(id))) {
    throw Error('MANUSCRIPT_RELATION_CHARACTER: 关系与称谓只能引用当前已登记角色ID，不能按姓名猜测。')
  }
  if (note.subject_id === note.object_id) throw Error('MANUSCRIPT_RELATION_SELF: 关系主体与客体不能是同一角色。')
  if (note.contextual_name && note.contextual_name.target_id !== note.subject_id
    && note.contextual_name.target_id !== note.object_id) {
    throw Error('MANUSCRIPT_RELATION_TARGET: 相对称谓须明确指向本条关系的一方。')
  }
  const evidence = await validateManuscriptEvidence(note.evidence, sources, cwd)
  const term = note.contextual_name?.term
  if (term && !evidence.some(entry => entry.quote.includes(term))) {
    throw Error('MANUSCRIPT_RELATION_TERM: 相对称谓须实际出现在所引原句中。')
  }
  const validated = { ...note, evidence }
  const issues = manuscriptRelationshipScopeIssues(validated, sources)
  if (issues.length > 0) throw Error(`MANUSCRIPT_RELATION_SCOPE: ${issues.map(issue => issue.message).join('\n')}`)
  const speakerIssues = manuscriptRelationshipSpeakerIssues(validated, sources, roster)
  if (speakerIssues.length > 0) throw Error(`MANUSCRIPT_RELATION_SPEAKER: ${speakerIssues.map(issue => issue.message).join('\n')}`)
  return validated
}
