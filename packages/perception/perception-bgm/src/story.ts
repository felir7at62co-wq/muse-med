/** Explicit musical intentions and auditable title/tag evidence; no audio or script inference. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { parseStoryEvidence, type StoryEvidenceReference } from './story-evidence.ts'

/** Supported musical intentions, selected by the agent after reading the actual scene. */
export const STORY_TAGS = ['family', 'romance', 'comedy', 'suspense', 'danger', 'action', 'sadness', 'hope',
  'daily_life', 'epic', 'restrained', 'gentle', 'solemn', 'energetic', 'playful', 'dark'] as const
type StoryTag = typeof STORY_TAGS[number]

/** A scene's desired audience response, distinct from literal action words in its dialogue. */
export interface StoryRequest {
  /** Current project script and observed-picture text quotations. */
  evidence?: StoryEvidenceReference[]
  intent: string
  /** Earlier tags take priority within title evidence, then within mood evidence. */
  desired_tags: StoryTag[]
  avoid_tags: StoryTag[]
  dialogue_density: 'none' | 'sparse' | 'dense' | 'unknown'
}

const cues: Record<StoryTag, RegExp> = {
  family: /亲情|家庭|\bfamily\b/i,
  romance: /浪漫|爱情|恋爱|心动|迷情|\b(?:romantic|romance|love)\b/i,
  comedy: /喜剧|搞笑|幽默|诙谐|\b(?:comedy|comic|funny|humorous)\b/i,
  suspense: /悬疑|悬念|调查|推理|暗流|\b(?:suspense|suspenseful|mysterious|mystery|tense)\b/i,
  danger: /危险|危机|惊险|\b(?:danger|dangerous|threat)\b/i,
  action: /打斗|战斗|战争|追逐|\b(?:action|battle|fight|chase|war)\b/i,
  sadness: /悲伤|悲痛|遗憾|哀伤|\b(?:sad|sadness|melancholic|grief|sorrow)\b/i,
  hope: /希望|未来|\b(?:hope|hopeful|inspiring|uplifting)\b/i,
  daily_life: /日常|生活|岁月静好|\b(?:daily life|everyday)\b/i,
  epic: /史诗|震撼|宏大|\b(?:epic|trailer)\b/i,
  restrained: /克制|含蓄|\b(?:restrained|subtle|understated)\b/i,
  gentle: /温柔|舒缓|温情|柔和|宁静|\b(?:gentle|soft|calm|relaxing)\b/i,
  solemn: /庄重|肃穆|\bsolemn\b/i,
  energetic: /热血|激昂|\b(?:energetic|energy)\b/i,
  playful: /俏皮|调皮|诙谐|\bplayful\b/i,
  dark: /阴暗|压迫|\bdark\b/i,
}

function tags(value: unknown, label: string, required: boolean): StoryTag[] {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || value.length > 8 || (required && value.length === 0)) {
    throw new Error(`story.${label} must be an array of ${required ? '1–8' : '0–8'} supported musical tags`)
  }
  return [...new Set(value.map((tag) => {
    const found = STORY_TAGS.find(known => known === tag)
    if (found === undefined) throw new Error(`story.${label} contains an unsupported tag: ${String(tag)}`)
    return found
  }))]
}

/** Validate model-provided story intent without guessing missing or contradictory requirements.
 * @param value - Optional story object from a match call.
 * @returns Explicit defaults for optional fields, or undefined for legacy emotion-only matching.
 */
export function parseStory(value: unknown): StoryRequest | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('story must be an object')
  const row = value as Record<string, unknown>
  if (typeof row.intent !== 'string' || !row.intent.trim() || Array.from(row.intent).length > 600) {
    throw new Error('story.intent must contain 1–600 characters describing the intended audience response')
  }
  const desired = tags(row.desired_tags, 'desired_tags', true)
  const avoided = tags(row.avoid_tags, 'avoid_tags', false)
  if (desired.some(tag => avoided.includes(tag))) throw new Error('story desired_tags and avoid_tags must not overlap')
  const density = row.dialogue_density ?? 'unknown'
  if (density !== 'none' && density !== 'sparse' && density !== 'dense' && density !== 'unknown') {
    throw new Error('story.dialogue_density must be none, sparse, dense or unknown')
  }
  const evidence = parseStoryEvidence(row.evidence)
  return { intent: row.intent.trim(), desired_tags: desired, avoid_tags: avoided, dialogue_density: density,
    ...(evidence === undefined ? {} : { evidence }) }
}

/** Visible evidence for ordering recommendations, never an audio-quality verdict. */
export interface StoryFit {
  status: 'supported' | 'unconfirmed' | 'title_conflict'
  title_matches: StoryTag[]
  mood_matches: StoryTag[]
  audio_matches: StoryTag[]
  title_conflicts: StoryTag[]
  mood_conflicts: StoryTag[]
  audio_conflicts: StoryTag[]
  missing_tags: StoryTag[]
  unknowns: string[]
}

/** Compare explicit musical intentions against title text and weaker catalogue mood labels.
 * @param title - Display filename only, excluding directory names.
 * @param moods - Existing catalogue or local-index labels, not newly inferred audio facts.
 * @param story - Validated intent for this scene.
 * @param audioTags - Optional top labels from hash-validated sampled audio inference.
 * @returns Separate positive/conflicting evidence with unmeasured audio properties left unknown.
 */
export function storyFit(title: string, moods: string[], story: StoryRequest, audioTags: readonly string[] = []): StoryFit {
  const inTitle = (tag: StoryTag) => cues[tag].test(title)
  const inMoods = (tag: StoryTag) => moods.some(mood => cues[tag].test(mood))
  const titleMatches = story.desired_tags.filter(inTitle)
  const moodMatches = story.desired_tags.filter(inMoods)
  const conflicts = story.avoid_tags.filter(inTitle)
  const audioMatches = story.desired_tags.filter(tag => audioTags.includes(tag))
  return { status: conflicts.length ? 'title_conflict' : titleMatches.length || moodMatches.length || audioMatches.length ? 'supported' : 'unconfirmed',
    title_matches: titleMatches, mood_matches: moodMatches, title_conflicts: conflicts,
    audio_matches: audioMatches, audio_conflicts: story.avoid_tags.filter(tag => audioTags.includes(tag)),
    mood_conflicts: story.avoid_tags.filter(inMoods),
    missing_tags: story.desired_tags.filter(tag => !inTitle(tag) && !inMoods(tag) && !audioTags.includes(tag)),
    unknowns: ['vocals', 'instruments', 'era', 'excerpt_suitability'] }
}

/** Order sampled-audio labels, title evidence and mood labels by the caller's intent priorities.
 * @param left - First candidate's visible evidence.
 * @param right - Second candidate's visible evidence.
 * @param story - Desired musical intentions in descending priority.
 * @returns Sort order, or zero when measured emotion distance should break the tie.
 */
export function compareStoryFits(left: StoryFit, right: StoryFit, story: StoryRequest): number {
  const conflict = Number(left.status === 'title_conflict') - Number(right.status === 'title_conflict')
  if (conflict) return conflict
  for (const field of ['audio_matches', 'title_matches', 'mood_matches'] as const) for (const tag of story.desired_tags) {
    const difference = Number(right[field].includes(tag)) - Number(left[field].includes(tag))
    if (difference) return difference
  }
  return 0
}

/** Produce bounded review guidance tied to the request, without claiming that audition occurred.
 * @param story - Validated scene intent and dialogue density.
 * @returns Request facts, ranking semantics and actual listening checks for the model-visible result.
 */
export function storyGuidance(story: StoryRequest): Record<string, JsonValue> {
  return { story_request: { ...story },
    ranking_rule: 'Explicit title conflicts go to review_candidates; compare sampled-audio label matches in desired_tags priority order, then title matches, then mood matches, then measured emotion distance. Audio/mood conflicts are advisory; audio labels are model inferences on listed windows, not human review. Intent prose records the agent’s interpretation and is not automatically understood.',
    audition_checks: [
      ...(story.dialogue_density === 'dense' ? ['Audition the densest dialogue: check word clarity, vocals, busy arrangement and original-music overlap; lowering volume alone may not resolve a style conflict.'] : []),
      'Check actual source music before adding another bed; compare selected_mix with without_added_music using drama_render audio_preview.',
      'Audition the exact source excerpt, entry, reveal and exit; do not reveal a twist early or claim verified era, instruments, vocals or suitability from title/tags alone.',
    ],
    note: 'Story evidence supports candidate review only; it is not a semantic confidence score, audio audition or guarantee of dramatic suitability.' }
}
