/** Validate optional, hash-bound sampled-audio metadata supplied by a public catalogue. */
import { STORY_TAGS } from './story.ts'

/** Raw audio/text cosine similarity; not a probability or a human-reviewed observation. */
export type ScoredAudioTag = { tag: string; similarity: number }
type AudioWindow = { start_seconds: number; end_seconds: number; tags: ScoredAudioTag[] }

/** Versioned inference metadata with exact sampled intervals and explicit review status. */
export interface AudioProfile {
  version: 1
  source_sha256: string
  analysis_method: 'sampled_clap_cosine_v1'
  model_id: string
  model_revision: string
  recipe_sha256: string
  human_reviewed: false
  analyzed_at: string
  duration_seconds: number
  sample_count: number
  sampled_seconds: number
  estimated_tempo_bpm: number | null
  rms_dbfs: number
  peak_dbfs: number
  tags: ScoredAudioTag[]
  instruments: ScoredAudioTag[]
  vocals: ScoredAudioTag[]
  windows: AudioWindow[]
  tag_scores: Record<string, number>
  review_note: string
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('audio_profile must be an object')
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || !value.isWellFormed()) {
    throw new Error(`audio_profile.${label} must be bounded nonempty text`)
  }
  return value
}

function number(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid audio_profile.${label}`)
  }
  return value
}

function scored(value: unknown, allowed?: readonly string[]): ScoredAudioTag[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error('Invalid audio_profile scored tags')
  const seen = new Set<string>()
  return value.map((raw: unknown) => {
    const row = object(raw)
    const tag = text(row.tag, 'tag', 64)
    if (seen.has(tag) || (allowed && !allowed.includes(tag))) throw new Error('Invalid or duplicate audio_profile tag')
    seen.add(tag)
    return { tag, similarity: number(row.similarity, 'similarity', -1, 1) }
  })
}

/** Validate machine-inferred metadata without promoting it to a verified listening judgment.
 * @param value - Optional audio_profile field at the catalogue JSON input.
 * @param sha256 - Exact digest of the owning catalogue track.
 * @returns Bounded metadata for those audio bytes, or undefined for an older catalogue.
 * @throws On invalid measurements, false review claims, mismatched identity or invalid sample coverage.
 */
export function parseAudioProfile(value: unknown, sha256: string): AudioProfile | undefined {
  if (value === undefined) return undefined
  const row = object(value)
  if (row.version !== 1 || row.source_sha256 !== sha256 || row.analysis_method !== 'sampled_clap_cosine_v1'
    || row.human_reviewed !== false) throw new Error('Invalid audio_profile version, source, method or review status')
  const revision = text(row.model_revision, 'model_revision', 40)
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid audio_profile model revision')
  const recipeHash = text(row.recipe_sha256, 'recipe_sha256', 71)
  if (!/^sha256:[a-f0-9]{64}$/.test(recipeHash)) throw new Error('Invalid audio_profile recipe digest')
  const analyzedAt = text(row.analyzed_at, 'analyzed_at', 64)
  if (!Number.isFinite(Date.parse(analyzedAt)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(analyzedAt)) {
    throw new Error('audio_profile.analyzed_at must be a timestamp with timezone')
  }
  const duration = number(row.duration_seconds, 'duration_seconds', Number.MIN_VALUE, Number.MAX_SAFE_INTEGER)
  const count = number(row.sample_count, 'sample_count', 1, 12)
  if (!Number.isInteger(count) || !Array.isArray(row.windows) || row.windows.length !== count) {
    throw new Error('audio_profile sample_count must equal its bounded windows')
  }
  const windows = row.windows.map((raw: unknown): AudioWindow => {
    const window = object(raw)
    const start = number(window.start_seconds, 'window start', 0, duration)
    const end = number(window.end_seconds, 'window end', 0, duration)
    if (end <= start || end - start > 10.01) throw new Error('Invalid audio_profile sampled window')
    return { start_seconds: start, end_seconds: end, tags: scored(window.tags, STORY_TAGS) }
  })
  let covered = 0
  let cursor = 0
  for (const window of [...windows].sort((a, b) => a.start_seconds - b.start_seconds)) {
    covered += Math.max(0, window.end_seconds - Math.max(cursor, window.start_seconds))
    cursor = Math.max(cursor, window.end_seconds)
  }
  const sampled = number(row.sampled_seconds, 'sampled_seconds', Number.MIN_VALUE, duration)
  if (Math.abs(covered - sampled) > 0.02) throw new Error('audio_profile sample coverage does not match its windows')
  const scores = object(row.tag_scores)
  if (Object.keys(scores).length !== STORY_TAGS.length) throw new Error('audio_profile requires every story tag score')
  const tagScores = Object.fromEntries(STORY_TAGS.map(tag => [tag, number(scores[tag], `tag_scores.${tag}`, -1, 1)]))
  const tags = scored(row.tags, STORY_TAGS)
  if (tags.some(tag => tag.similarity !== tagScores[tag.tag])) throw new Error('audio_profile tag summaries differ from scores')
  return { version: 1, source_sha256: sha256, analysis_method: 'sampled_clap_cosine_v1',
    model_id: text(row.model_id, 'model_id', 128), model_revision: revision, recipe_sha256: recipeHash,
    human_reviewed: false, analyzed_at: analyzedAt,
    duration_seconds: duration, sample_count: count, sampled_seconds: sampled,
    estimated_tempo_bpm: row.estimated_tempo_bpm === null ? null : number(row.estimated_tempo_bpm, 'estimated_tempo_bpm', Number.MIN_VALUE, 1000),
    rms_dbfs: number(row.rms_dbfs, 'rms_dbfs', -200, 30), peak_dbfs: number(row.peak_dbfs, 'peak_dbfs', -200, 30),
    tags, instruments: scored(row.instruments),
    vocals: scored(row.vocals, ['instrumental', 'singing', 'speech']), windows, tag_scores: tagScores,
    review_note: text(row.review_note, 'review_note', 600) }
}
