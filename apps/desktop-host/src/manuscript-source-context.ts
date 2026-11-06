/** Source-title indexing keeps authored settings, episode occurrences and evidence ranges separate from dialogue. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { manuscriptReadingText } from './manuscript-reading.ts'
import { parseManuscriptHeading } from './manuscript-scenes.ts'

/** Model-visible limits on claims about events, numerical changes and dialogue recipients. */
export const MANUSCRIPT_FACT_GUIDANCE = '按原文区分计划、尝试、实际完成和后果；人物当前地点、计划目标地点、声音来源和对白谈及地点分别记录。时间线保留已明示的相邻事件与相对时间，未知间隔不补写。条件奖励和算术相合不证明完成任务或到账；但已宣布生效的任命、待遇标准本身就是变化，与实际领取另记，不因没演工资条或到账就把新标准列为未解。关系结论沿用有依据的原称谓和方向，不自行另起亲属总称。称谓所指人不自动是受话人，人物表不证明谁听见；向第三人谈及某人不能写成向该人当面称呼。被阻止或尚在计划中的事，不写成已发生或事后。'

/** A scene occurrence within one exact source version, distinct from adopted-candidate scene IDs. */
export type ManuscriptSourceSceneId = Branded<'ManuscriptSourceSceneId'>

/** An actual title line and its authored label. */
export interface ManuscriptSourceHeading {
  line: number
  text: string
  label: string
}

/** One contiguous source section; episode-only bodies and unrecognized text have no scene ID. */
export interface ManuscriptSourceSection {
  section_index: number
  source_scene_id: ManuscriptSourceSceneId | null
  kind: 'scene' | 'episode_body' | 'unassigned'
  episode: string
  episode_number: string | null
  episode_label: string | null
  episode_basis: 'episode_heading' | 'scene_number' | 'unassigned'
  episode_index: number | null
  scene_id: string | null
  scene_episode_label: string | null
  episode_scene_consistency: 'matches' | 'conflict' | 'not_compared'
  heading: string | null
  heading_line: number | null
  heading_setting: string | null
  episode_heading: ManuscriptSourceHeading | null
  scene_heading: ManuscriptSourceHeading | null
  start_line: number
  end_line: number
  previous_scene_index: number | null
  next_scene_index: number | null
}

/** Complete line ownership for one source, retaining duplicate title occurrences. */
export interface ManuscriptSourceIndex {
  total_lines: number
  sections: ManuscriptSourceSection[]
}

/** Source ownership intersecting a citation, together with complete adjacent section references. */
export interface ManuscriptSourceRangeSection extends ManuscriptSourceSection {
  selected_start_line: number
  selected_end_line: number
  previous_section: ManuscriptSourceSection | null
  next_section: ManuscriptSourceSection | null
}

/** Every actual title scope touched by an inclusive source line range. */
export interface ManuscriptSourceRangeContext {
  start_line: number
  end_line: number
  crosses_episodes: boolean
  crosses_scenes: boolean
  sections: ManuscriptSourceRangeSection[]
}

/** An adjacent source section's actual identity, title and complete reread range. */
export type ManuscriptSourceNavigationReference = Pick<ManuscriptSourceSection,
  'section_index' | 'source_scene_id' | 'episode' | 'scene_id' | 'heading' | 'start_line' | 'end_line'>

/** Complete selected ownership with bounded neighboring-section navigation. */
export interface ManuscriptSourcePageSection extends Omit<ManuscriptSourceRangeSection, 'previous_section' | 'next_section'> {
  previous_section: ManuscriptSourceNavigationReference | null
  next_section: ManuscriptSourceNavigationReference | null
}

/** Selected source sections for one model-visible reading page. */
export interface ManuscriptSourcePageContext extends Omit<ManuscriptSourceRangeContext, 'sections'> {
  sections: ManuscriptSourcePageSection[]
}

/** Exact selected line ownership without inferred event time or location. */
export interface ManuscriptSourceCitationLabel {
  start_line: number
  end_line: number
  episode: string
  scene_id: string | null
  source_scene_id: ManuscriptSourceSceneId | null
}

/** One complete reading-text line beginning with △, without interpreting its time, event or truth. */
export interface ManuscriptSourceCue {
  line: number
  text: string
  citation_labels: ManuscriptSourceCitationLabel[]
}

/** Complete selected evidence ownership without adjacent-section copies. */
export type ManuscriptSourceCitationSection = Omit<ManuscriptSourceRangeSection, 'previous_section' | 'next_section'>

/** Exact citation ownership and direct labels; neighboring text is retrieved through reading pages. */
export interface ManuscriptSourceCitationContext extends Omit<ManuscriptSourceRangeContext, 'sections'> {
  citation_labels: ManuscriptSourceCitationLabel[]
  sections: ManuscriptSourceCitationSection[]
}

/** Literal line notation, without inferred audibility, identity or narrative truth. */
export interface ManuscriptSourceLineLabel {
  line: number
  kind: 'heading' | 'action' | 'dialogue' | 'other'
  speaker_label: string | null
  voice_marker: string | null
  speaker_annotation: string | null
  /** One-based Unicode column immediately after the speech delimiter, including any following spaces. */
  speech_column: number | null
}

const voiceLabel = /^(?:OS|VO|旁白|画外音|画外声|心声)$/iu
const metadataLabels = new Set(['人物', '角色', '场景', '地点', '时间', '标题', '系统档案', '档案', '姓名', '身份', '当前身份', '现任身份', '发声说明'])

function sourceLines(sourceText: string): string[] {
  if (sourceText.length === 0) return []
  const text = manuscriptReadingText(sourceText), lines = text.split('\n')
  if (text.endsWith('\n') && !sourceText.endsWith('\r')) lines.pop()
  return lines
}

function speechDelimiter(raw: string): { delimiter: number; annotation: number } | null {
  const closing: string[] = []
  let annotation = -1
  for (let offset = 0; offset < raw.length; offset++) {
    const character = raw[offset]
    if ((character === ':' || character === '：') && closing.length === 0) return { delimiter: offset, annotation }
    if (character === '(' || character === '（') {
      if (annotation === -1) annotation = offset
      closing.push(character === '(' ? ')' : '）')
    } else if (character === ')' || character === '）') {
      if (closing.pop() !== character) return null
    } else if (annotation !== -1 && closing.length === 0 && character?.trim() !== '') return null
  }
  return null
}

function sourceLineLabel(raw: string, line: number): ManuscriptSourceLineLabel {
  const other: ManuscriptSourceLineLabel = { line, kind: 'other', speaker_label: null,
    voice_marker: null, speaker_annotation: null, speech_column: null }
  if (parseManuscriptHeading(raw)) return { ...other, kind: 'heading' }
  if (/^\s*[▲△]/u.test(raw)) return { ...other, kind: 'action' }
  if (/^\s*[【[{]/u.test(raw)) return other
  const split = speechDelimiter(raw)
  if (!split) return other
  const annotation = split.annotation === -1 ? null : raw.slice(split.annotation, split.delimiter).trim()
  let label = raw.slice(0, split.annotation === -1 ? split.delimiter : split.annotation).trim()
  if (metadataLabels.has(label)) return other
  const bareVoice = voiceLabel.test(label)
  const suffix = /(OS|VO)$/iu.exec(label)
  let marker = bareVoice ? label : null
  if (!bareVoice && suffix && suffix.index > 0 && /[\s\p{Script=Han}\d]$/u.test(label.slice(0, suffix.index))) {
    marker = suffix[0]
    label = label.slice(0, suffix.index).trim()
  }
  const annotatedVoice = annotation === null ? null
    : /(?:^|[^\p{L}\p{N}_])(OS|VO)(?=$|[^\p{L}\p{N}_])|(心声|画外音|画外声)/iu.exec(annotation)
  marker ??= annotatedVoice?.[1] ?? annotatedVoice?.[2] ?? null
  if (!bareVoice && !/^[\p{L}\p{N}·_.\s-]+$/u.test(label)) return other
  return { line, kind: bareVoice ? 'other' : 'dialogue', speaker_label: bareVoice ? null : label,
    voice_marker: marker, speaker_annotation: annotation,
    speech_column: Array.from(raw.slice(0, split.delimiter + 1)).length + 1 }
}

/**
 * Read literal line labels from complete source lines, including prefixes outside a returned page fragment.
 * @param sourceText - Complete extracted source version, unchanged by interpretation.
 * @param start_line - Inclusive first line, starting at one.
 * @param end_line - Inclusive last line.
 * @returns Original annotations and markers, including the reader's empty and terminal lines; audibility is not inferred.
 * @throws Error when the selected source line range does not exist.
 */
export function manuscriptSourceLineLabels(sourceText: string, start_line: number, end_line: number): ManuscriptSourceLineLabel[] {
  const lines = manuscriptReadingText(sourceText).split('\n')
  if (!Number.isSafeInteger(start_line) || !Number.isSafeInteger(end_line)
    || start_line < 1 || end_line < start_line || end_line > lines.length) {
    throw Error('MANUSCRIPT_SOURCE_CONTEXT_RANGE: 来源行范围不存在。')
  }
  return lines.slice(start_line - 1, end_line).map((line, offset) => sourceLineLabel(line, start_line + offset))
}

const digits = new Map([...Array.from('零一二三四五六七八九', (character, value) => [character, value] as const), ['〇', 0] as const])
const units = new Map([['十', 10], ['百', 100]])

function episodeNumber(label: string): string | null {
  if (/^\d+$/u.test(label)) return label.replace(/^0+(?=\d)/u, '')
  if (!/[十百]/u.test(label)) {
    const parts = Array.from(label, character => digits.get(character))
    return parts.every(value => value !== undefined) ? parts.join('').replace(/^0+(?=\d)/u, '') : null
  }
  let total = 0, pending = 0, lastUnit = Number.POSITIVE_INFINITY
  for (const character of label) {
    const digit = digits.get(character)
    if (digit !== undefined) { pending = pending * 10 + digit; continue }
    const unit = units.get(character)
    if (unit === undefined || unit >= lastUnit) return null
    total += (pending || 1) * unit
    pending = 0; lastUnit = unit
  }
  return Number.isSafeInteger(total + pending) ? String(total + pending) : null
}

/**
 * Index only explicit source titles; neither dialogue locations nor mentioned chapters create sections.
 * @param sourceText - Complete extracted source text, never a page or model-authored summary.
 * @returns Ordered, inclusive line sections with original headings and independent source scene occurrences.
 */
export function indexManuscriptSource(sourceText: string): ManuscriptSourceIndex {
  const lines = sourceLines(sourceText)
  if (lines.length === 0) return { total_lines: 0, sections: [] }
  const sections: ManuscriptSourceSection[] = []
  let current: Omit<ManuscriptSourceSection, 'section_index' | 'start_line' | 'end_line'> = {
    source_scene_id: null, kind: 'unassigned', episode: 'unassigned', episode_number: null,
    episode_label: null, episode_basis: 'unassigned', episode_index: null,
    scene_id: null, scene_episode_label: null, episode_scene_consistency: 'not_compared',
    heading: null, heading_line: null, heading_setting: null, episode_heading: null, scene_heading: null,
    previous_scene_index: null, next_scene_index: null,
  }
  let start = 1, episodeIndex = 0, sceneIndex = 0
  const append = (end: number): void => {
    if (end >= start) sections.push({ ...current, section_index: sections.length + 1, start_line: start, end_line: end })
  }
  for (const [offset, raw] of lines.entries()) {
    const title = parseManuscriptHeading(raw)
    if (!title) continue
    const line = offset + 1
    append(line - 1); start = line
    const reference = { line, text: raw, label: title.label }
    if (title.kind === 'episode') {
      current = { ...current, kind: 'episode_body', episode: title.episode,
        episode_number: episodeNumber(title.episode), episode_label: title.label,
        episode_basis: 'episode_heading', episode_index: ++episodeIndex, episode_heading: reference,
        source_scene_id: null, scene_id: null, scene_episode_label: null,
        episode_scene_consistency: 'not_compared', scene_heading: null,
        heading: raw, heading_line: line, heading_setting: null }
      continue
    }
    if (current.episode_basis !== 'episode_heading' && current.episode !== title.episode) {
      current = { ...current, episode: title.episode, episode_number: episodeNumber(title.episode),
        episode_label: title.episode, episode_basis: 'scene_number', episode_index: ++episodeIndex }
    }
    const sceneEpisode = episodeNumber(title.episode)
    current = { ...current, kind: 'scene', source_scene_id: brandString<ManuscriptSourceSceneId>(`source-scene-${++sceneIndex}`),
      scene_id: title.label, scene_episode_label: title.episode,
      episode_scene_consistency: current.episode_number === null || sceneEpisode === null ? 'not_compared'
        : current.episode_number === sceneEpisode ? 'matches' : 'conflict',
      scene_heading: reference, heading: raw, heading_line: line, heading_setting: title.setting }
  }
  append(lines.length)
  let previous: number | null = null
  for (const section of sections) {
    section.previous_scene_index = previous
    if (section.kind === 'scene') previous = section.section_index
  }
  let next: number | null = null
  for (const section of sections.toReversed()) {
    section.next_scene_index = next
    if (section.kind === 'scene') next = section.section_index
  }
  return { total_lines: lines.length, sections }
}

/**
 * Locate all citation sections without reducing repeated or cross-episode titles to a single label.
 * @param index - Complete index for the same exact source version as the citation.
 * @param start_line - Inclusive first source line, starting at one.
 * @param end_line - Inclusive last source line.
 * @returns Selected ownership, complete section bounds and adjacent section references; no location or story time is inferred.
 */
export function manuscriptSourceRangeContext(index: ManuscriptSourceIndex, start_line: number,
  end_line: number): ManuscriptSourceRangeContext {
  if (!Number.isSafeInteger(start_line) || !Number.isSafeInteger(end_line)
    || start_line < 1 || end_line < start_line || end_line > index.total_lines) {
    throw Error('MANUSCRIPT_SOURCE_CONTEXT_RANGE: 来源行范围不存在。')
  }
  const sections = index.sections.filter(section => section.start_line <= end_line && section.end_line >= start_line)
    .map(section => ({ ...section, selected_start_line: Math.max(start_line, section.start_line),
      selected_end_line: Math.min(end_line, section.end_line),
      previous_section: index.sections[section.section_index - 2] ?? null,
      next_section: index.sections[section.section_index] ?? null }))
  return { start_line, end_line,
    crosses_episodes: new Set(sections.flatMap(section => section.episode_index === null ? [] : [section.episode_index])).size > 1,
    crosses_scenes: new Set(sections.flatMap(section => section.source_scene_id ? [section.source_scene_id] : [])).size > 1,
    sections }
}

function navigationReference(section: ManuscriptSourceSection | null): ManuscriptSourceNavigationReference | null {
  return section === null ? null : { section_index: section.section_index, source_scene_id: section.source_scene_id,
    episode: section.episode, scene_id: section.scene_id, heading: section.heading,
    start_line: section.start_line, end_line: section.end_line }
}

/**
 * Present complete selected ownership without repeating full adjacent-section metadata.
 * @param index - Complete index for the same exact source version as the page.
 * @param start_line - Inclusive first returned source line, starting at one.
 * @param end_line - Inclusive last returned source line.
 * @returns Full selected fields and actual neighboring identities, titles and reread ranges.
 * @throws Error when the requested source line range does not exist.
 */
export function manuscriptSourcePageContext(index: ManuscriptSourceIndex, start_line: number,
  end_line: number): ManuscriptSourcePageContext {
  const context = manuscriptSourceRangeContext(index, start_line, end_line)
  return { ...context, sections: context.sections.map(section => ({ ...section,
    previous_section: navigationReference(section.previous_section), next_section: navigationReference(section.next_section) })) }
}

/**
 * Label each selected source range using its actual title ownership.
 * @param context - Source range or reading-page ownership, independent of model-authored labels.
 * @returns Exact selected intervals with authored episode labels and distinct source scene occurrences.
 */
export function manuscriptSourceCitationLabels(
  context: ManuscriptSourceRangeContext | ManuscriptSourcePageContext | ManuscriptSourceCitationContext,
): ManuscriptSourceCitationLabel[] {
  return context.sections.map(section => ({ start_line: section.selected_start_line, end_line: section.selected_end_line,
    episode: section.episode_label ?? section.episode, scene_id: section.scene_id, source_scene_id: section.source_scene_id }))
}

/**
 * Collect literal △ cue lines as source navigation, including non-temporal notes.
 * @param sourceText - Complete extracted source version, never a page fragment or model summary.
 * @returns Full reading-text lines, retaining whitespace and markers, with actual source citation labels; no event is inferred.
 */
export function manuscriptSourceCues(sourceText: string): ManuscriptSourceCue[] {
  const index = indexManuscriptSource(sourceText)
  return sourceLines(sourceText).flatMap((text, offset) => {
    if (!/^\s*△/u.test(text)) return []
    const line = offset + 1
    return [{ line, text, citation_labels: manuscriptSourceCitationLabels(manuscriptSourceRangeContext(index, line, line)) }]
  })
}

/**
 * Present exact selected evidence ownership without copying adjacent sections.
 * @param range - Complete canonical ownership of the source quotation.
 * @returns Actual range, cross-section flags, direct labels and every selected-section field except neighbors.
 */
export function manuscriptSourceCitationContext(range: ManuscriptSourceRangeContext): ManuscriptSourceCitationContext {
  return { start_line: range.start_line, end_line: range.end_line,
    crosses_episodes: range.crosses_episodes, crosses_scenes: range.crosses_scenes,
    citation_labels: manuscriptSourceCitationLabels(range),
    sections: range.sections.map(({ previous_section: _previous, next_section: _next, ...selected }) => selected) }
}
