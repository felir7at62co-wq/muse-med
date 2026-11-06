/** Bounded, current-version manuscript facts restored after conversation compaction. */
import type { ManuscriptCharacter, ManuscriptRelationship, ManuscriptRelationshipSourceContext } from './manuscript-relationships.ts'
import { comparisonEvidence, type annotateComparison } from './manuscript-comparison.ts'
import { serializeManuscriptData } from './manuscript-report.ts'
import { manuscriptSourceCitationLabels, type ManuscriptSourceRangeContext,
  type ManuscriptSourceCitationContext } from './manuscript-source-context.ts'

/** One currently adopted source or manuscript file. */
export interface ManuscriptCheckpointFile {
  path: string
  sha256: string
}

/** Unread source lines belonging to one exact current file version. */
export interface ManuscriptCheckpointCoverage extends ManuscriptCheckpointFile {
  missing: readonly { start_line: number; end_line: number; start_column?: number; end_column?: number }[]
}

/** A model-authored event whose two anchors must still identify current text. */
export interface ManuscriptCheckpointEvent {
  event_id: string
  scene_id: string
  quote: string
  source_quote: string
  source_path: string
  purpose: 'advance' | 'recap' | 'flashback'
  end_state: string
  sha256: string
  source_sha256: string
}

/** Current task evidence supplied by the manuscript owner's file reconciliation. */
export interface ManuscriptCheckpointInput {
  task_key: string
  mode: 'adapt' | 'transcribe' | 'edit'
  version: string
  sources: readonly ManuscriptCheckpointFile[]
  files: readonly ManuscriptCheckpointFile[]
  scenes: readonly { id: string; sha256: string }[]
  coverage: readonly ManuscriptCheckpointCoverage[]
  characters: readonly ManuscriptCharacter[]
  relationships: readonly (ManuscriptRelationship & { source_contexts?: readonly ManuscriptRelationshipSourceContext[] })[]
  comparisons?: readonly ReturnType<typeof annotateComparison>[]
  event_notes: readonly ManuscriptCheckpointEvent[]
  known_read_sources?: number
  invalidated_event_notes?: number
}

/** Complete evidence rows omitted to satisfy the configured character ceiling. */
export interface ManuscriptCheckpointOmissions {
  sources: number
  files: number
  missingIntervals: number
  characters: number
  relationships: number
  comparisons: number
  eventNotes: number
}

/** Rendered checkpoint and explicit counts for omitted or outdated evidence. */
export interface ManuscriptCheckpoint {
  text: string
  characters: number
  truncated: boolean
  taskKeyOmitted: boolean
  omitted: ManuscriptCheckpointOmissions
  stale: { coverage: number; characters: number; relationships: number; comparisons: number; eventNotes: number }
}

type CheckpointEntry =
  | { kind: 'sources'; value: ManuscriptCheckpointFile & { reading: 'unrecorded' | 'incomplete' | 'complete' } }
  | { kind: 'files'; value: ManuscriptCheckpointFile }
  | { kind: 'missingIntervals'; value: ManuscriptCheckpointFile & { start_line: number; end_line: number; start_column?: number; end_column?: number } }
  | { kind: 'characters'; value: ManuscriptCharacter }
  | { kind: 'relationships'; value: ManuscriptRelationship }
  | { kind: 'comparisons'; value: ReturnType<typeof checkpointComparison> }
  | { kind: 'eventNotes'; value: ManuscriptCheckpointEvent }

const INTRODUCTION = '当前版本文稿资料检查点。引文、人物关系与事件状态是待核对资料和模型笔记。未明示的身份、所属或知晓状态记为未知；引文未提及不等于不存在。先导、闪回、旧剧情档案与正文当前事件分开记录。source_contexts是引文的真实集场出处，不自动证明关系何时生效。当前地点须结合标题及本场实际动作；复合场景设置要回读场内移动，不能用对白提到的别处替换。数字不同先核对人物、指标、单位、岗位和阶段及变化原因，不能直接报矛盾。\n'
const RECOVERY = '\n完整索引、原稿△提示行与省略条目用 manuscript_work audit 回读。用read_source的source_path、source_sha256、offset、column和limit回读实际来源及source_contexts的整场范围；数值疑点用comparison登记两端与变化原因引文。返回文本的覆盖记录不证明剧情理解正确。'

function checkpointSourceContext(context: ManuscriptSourceRangeContext | ManuscriptSourceCitationContext) {
  return { start_line: context.start_line, end_line: context.end_line,
    crosses_episodes: context.crosses_episodes, crosses_scenes: context.crosses_scenes,
    citation_labels: manuscriptSourceCitationLabels(context),
    sections: context.sections.map(section => ({ episode: section.episode, episode_number: section.episode_number,
      source_scene_id: section.source_scene_id, scene_id: section.scene_id, heading: section.heading,
      heading_line: section.heading_line, heading_setting: section.heading_setting,
      start_line: section.start_line, end_line: section.end_line })) }
}

function checkpointComparison(row: ReturnType<typeof annotateComparison>) {
  const contexts = (values: typeof row.source_contexts.before) => values.map(value => ({
    source_path: value.source_path, source_sha256: value.source_sha256, ...checkpointSourceContext(value.context),
    time_basis: value.time_basis, line_labels: value.line_labels.map(({ line, kind, speaker_label, voice_marker }) => ({
      line, kind, speaker_label, voice_marker })) }))
  return { record: row.record, literal_difference: row.literal_difference, effective_interpretation: row.effective_interpretation,
    citation_labels: row.citation_labels,
    missing_basis: row.missing_basis, interpretation_reasons: row.interpretation_reasons,
    source_contexts: { before: contexts(row.source_contexts.before),
      after: contexts(row.source_contexts.after), explanation: contexts(row.source_contexts.explanation) },
    bridge_ranges: row.bridge_ranges.map(({ source_path, source_sha256, start_line, end_line }) => ({
      source_path, source_sha256, start_line, end_line })),
    semantic_assessment: row.semantic_assessment, contradiction_proven: row.contradiction_proven,
    labels_verified: row.labels_verified, intervening_context_assessed: row.intervening_context_assessed }
}

/**
 * Restore complete, current-version evidence rows within a bounded context message.
 * Relationship direction, uncertainty, scope and quotations remain verbatim. The
 * owner validates quotations against source bytes before supplying these rows.
 * @param input - Reconciled current files, source coverage and model-authored notes.
 * @param options - Deployment-owned UTF-16 ceiling of at least 1024 and optional canonical workspace for local paths.
 * @returns Deterministic context text with explicit omitted and outdated counts.
 * @throws RangeError when the ceiling cannot retain mandatory version and recovery information.
 */
export function formatManuscriptCheckpoint(
  input: ManuscriptCheckpointInput,
  options: { maxCharacters: number; cwd?: string },
): ManuscriptCheckpoint {
  if (!Number.isSafeInteger(options.maxCharacters) || options.maxCharacters < 1024) {
    throw new RangeError('MANUSCRIPT_CHECKPOINT_LIMIT: maxCharacters must be an integer of at least 1024.')
  }
  const sourceVersions = new Map(input.sources.map(source => [source.path, source.sha256]))
  const sceneVersions = new Map(input.scenes.map(scene => [scene.id, scene.sha256]))
  const coverage = input.coverage.filter(row => sourceVersions.get(row.path) === row.sha256)
  const characters = input.characters.filter(row => row.evidence.every(
    anchor => sourceVersions.get(anchor.source_path) === anchor.source_sha256))
  const identities = new Set(characters.map(row => row.character_id))
  const relationships = input.relationships.filter(row => identities.has(row.subject_id) && identities.has(row.object_id)
    && row.evidence.every(anchor => sourceVersions.get(anchor.source_path) === anchor.source_sha256))
    .map(row => row.source_contexts ? { ...row, source_contexts: row.source_contexts.map(context => ({
      source_path: context.source_path, source_sha256: context.source_sha256, ...checkpointSourceContext(context),
      time_basis: context.time_basis, line_labels: context.line_labels.map(({ line, kind, speaker_label, voice_marker }) => ({
        line, kind, speaker_label, voice_marker })) })) } : row)
  const eventNotes = input.event_notes.filter(row => sourceVersions.get(row.source_path) === row.source_sha256
    && sceneVersions.get(row.scene_id) === row.sha256)
  const comparisons = (input.comparisons ?? []).filter(row => identities.has(row.record.subject_id)
    && comparisonEvidence(row.record).every(anchor => sourceVersions.get(anchor.source_path) === anchor.source_sha256))
  const stale = { coverage: input.coverage.length - coverage.length,
    characters: input.characters.length - characters.length,
    relationships: input.relationships.length - relationships.length,
    comparisons: (input.comparisons?.length ?? 0) - comparisons.length,
    eventNotes: input.event_notes.length - eventNotes.length }
  const coverageByPath = new Map(coverage.map(row => [row.path, row]))
  const missing = coverage.flatMap(row => row.missing.map(range => ({ kind: 'missingIntervals' as const,
    value: { path: row.path, sha256: row.sha256, ...range } })))
  const groups: readonly (readonly CheckpointEntry[])[] = [
    missing,
    characters.map(value => ({ kind: 'characters', value })),
    relationships.map(value => ({ kind: 'relationships', value })),
    comparisons.map(value => ({ kind: 'comparisons', value: checkpointComparison(value) })),
    eventNotes.map(value => ({ kind: 'eventNotes', value })),
    input.sources.map((value) => {
      const current = coverageByPath.get(value.path)
      return { kind: 'sources', value: { path: value.path, sha256: value.sha256,
        reading: current === undefined ? 'unrecorded' : current.missing.length > 0 ? 'incomplete' : 'complete' } }
    }),
    input.files.map(value => ({ kind: 'files', value: { path: value.path, sha256: value.sha256 } })),
  ]
  const omitted: ManuscriptCheckpointOmissions = { sources: input.sources.length, files: input.files.length,
    missingIntervals: missing.length, characters: characters.length, relationships: relationships.length,
    comparisons: comparisons.length, eventNotes: eventNotes.length }
  const entries: CheckpointEntry[] = []
  let taskKeyOmitted = false
  const render = () => INTRODUCTION + serializeManuscriptData({ version: input.version, mode: input.mode,
    ...(taskKeyOmitted ? { task_key_omitted: true } : { task_key: input.task_key }),
    source_reading: { sources: input.sources.length, known_read_sources: input.known_read_sources,
      unrecorded_sources: input.sources.filter(source => !coverageByPath.has(source.path)).length,
      missing_intervals: missing.length },
    excluded_stale: stale, invalidated_event_notes: input.invalidated_event_notes ?? 0, omitted, entries,
  }, options.cwd) + RECOVERY
  if (render().length > options.maxCharacters) taskKeyOmitted = true
  if (render().length > options.maxCharacters) {
    throw new RangeError('MANUSCRIPT_CHECKPOINT_LIMIT: current version and recovery information exceed maxCharacters.')
  }
  const largestGroup = Math.max(...groups.map(group => group.length))
  for (let index = 0; index < largestGroup; index++) {
    for (const group of groups) {
      const entry = group[index]
      if (entry === undefined) continue
      entries.push(entry)
      omitted[entry.kind]--
      if (render().length > options.maxCharacters) {
        entries.pop()
        omitted[entry.kind]++
      }
    }
  }
  const text = render()
  return { text, characters: text.length, truncated: taskKeyOmitted || Object.values(omitted).some(count => count > 0),
    taskKeyOmitted, omitted, stale }
}
