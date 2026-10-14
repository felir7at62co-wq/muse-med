/** Validated screenplay sources, candidate records, and model commands. @module screenplay-project/schema */

import { z } from 'zod'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { TRUSTED_VIDEO_INSPECTION_RECEIPT } from '@deepseek-ai/dsh-tool-video-inspect'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { ActorId, CandidateId, FactId, ProjectId, SourceId, UnitId } from './ids.ts'

const string = { type: 'string', required: true } as const
const strings = { type: 'array', items: { type: 'string' }, required: true } as const
const integer = { type: 'integer', required: true } as const
const anchor = {
  type: 'object', additionalProperties: false,
  properties: { unit_id: string, quote: string },
} as const
const fact = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['action', 'speech', 'thought', 'author_analysis'], required: true },
    origin: { type: 'string', enum: ['source', 'adaptation'], required: true },
    actor: { type: 'string' },
    layer: { type: 'string', enum: ['present', 'flashback', 'dream', 'imagined', 'commentary'], required: true },
    summary: string,
    anchors: { type: 'array', items: anchor, required: true },
    adaptation_reason: { type: 'string' },
  },
} as const
const beat = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['action', 'dialogue', 'os', 'vo'], required: true },
    actor: { type: 'string' },
    text: string,
    fact_ids: strings,
    requires_knowledge: strings,
    witnesses: strings,
    audible_in_scene: { type: 'boolean', description: 'VO only: true when actual characters hear the approved speech, such as a phone call or played voice message. Name those listeners in witnesses. Omission or false remains audience-only.' },
    hook: { type: 'boolean', description: 'Mark the existing episode-end suspense beat, never invent a hook for faithful source material.' },
  },
} as const
const scene = {
  type: 'object', additionalProperties: false,
  properties: {
    location: string,
    time: string,
    setting: { type: 'string', enum: ['内', '外', '内外'], description: 'Source-verified interior or exterior; omission remains explicitly unresolved in the script.' },
    layer: { type: 'string', enum: ['present', 'flashback', 'dream', 'imagined'], required: true },
    transition: { type: 'string', enum: ['opening', 'continuous', 'cut', 'enter_flashback', 'return_present'], required: true },
    characters: strings,
    voice_only_characters: { type: 'array', items: { type: 'string' }, description: 'Exact character names heard only as VO in this scene. Keep characters and actor names undecorated; the renderer adds the VO label.' },
    beats: { type: 'array', items: beat, required: true },
  },
} as const
const mutation = { project: string, expected_revision: integer }
const coverage = {
  type: 'object', additionalProperties: false,
  properties: {
    windows: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: { source_id: string, start: integer, count: integer,
        interval: { type: 'object', additionalProperties: false,
          description: 'Episode time range within this sampled-video manifest. Omission checks the complete manifest range. Sampling never establishes continuous visual coverage.',
          properties: { start_seconds: { type: 'number', required: true }, end_seconds: { type: 'number', required: true } } },
      },
    } },
    required_beats: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: {
        fact_id: string, kind: { type: 'string', enum: ['action', 'dialogue', 'os', 'vo'], required: true },
      },
    } },
  },
} as const
const review = {
  decision: { type: 'string', enum: ['approve', 'reject'], required: true },
  reason: string,
} as const

/** Exact operation-specific arguments exposed to the model. */
export const REQUEST = {
  oneOf: [
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'init', required: true }, project: string,
      mode: { type: 'string', enum: ['faithful', 'adaptation'], required: true }, instructions: string,
      workflow: { type: 'string', enum: ['video_to_screenplay'], description: 'Managed video conversion: visual source preparation, coverage review and accepted-only final delivery.' },
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'import_source', required: true }, ...mutation,
      path: string, source_kind: { type: 'string', enum: ['text', 'transcript', 'video_inspection'], required: true },
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'fork_project', required: true }, ...mutation,
      destination: string, before_episode: integer,
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'read_source', required: true }, project: string,
      source_id: string, start: integer, count: integer,
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'propose_fact', required: true }, ...mutation, fact: { ...fact, required: true },
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'propose_facts', required: true }, ...mutation,
      facts: { type: 'array', items: fact, required: true },
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'review_facts', required: true }, ...mutation,
      reviews: { type: 'array', required: true, items: {
        type: 'object', additionalProperties: false, properties: { fact_id: string, ...review },
      } },
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'review_fact', required: true }, ...mutation, fact_id: string, ...review,
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'withdraw_fact', required: true }, ...mutation, fact_id: string, reason: string,
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'stage', required: true }, ...mutation, episode: integer,
      scenes: { type: 'array', items: scene, required: true },
      coverage,
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'stage_files', required: true }, ...mutation, episode: integer,
      files: { type: 'array', items: { type: 'string' }, required: true,
        description: 'Ordered JSON files, each containing one scene object at the root with location, time, characters and beats; no scenes array wrapper.' },
      coverage,
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'review', required: true }, ...mutation,
      candidate_id: string, candidate_sha256: string, ...review,
      zero_action_reason: { type: 'string', description: 'For approving a managed video episode with no action beats: actual visual/source recheck and why no essential action is missing. Never invent action to avoid this review.' },
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'commit', required: true }, ...mutation,
      candidate_id: string, candidate_sha256: string,
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'status', required: true }, project: string,
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'read_fact', required: true }, project: string, fact_id: string,
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'list_facts', required: true }, project: string, start: integer, count: integer,
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'read_candidate', required: true }, project: string, candidate_id: string,
    } },
    { type: 'object', additionalProperties: false, properties: {
      method: { type: 'string', const: 'export', required: true }, project: string,
      candidate_id: string, directory: string,
    } },
  ],
} as const satisfies ValueSchemaSpec


const supplement = {
  type: 'object', additionalProperties: false,
  properties: { policy_sha256: string, category: { type: 'string', required: true,
    enum: ['performance_detail', 'minimal_os', 'supporting_dialogue'] }, authorization_sha256: string },
} as const
const locatedText = { type: 'object', additionalProperties: false,
  properties: { scene: integer, beat: integer, text: string } } as const
const modificationNotes = { type: 'object', additionalProperties: false, properties: {
  changes: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
    properties: { before: locatedText, after: locatedText, reason: string } } },
  editor_comments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
    properties: { comment: string, disposition: { type: 'string', required: true,
      enum: ['adopted', 'partial', 'not_adopted', 'unknown'] }, reason: string, change_indices: { type: 'array', required: true, items: { type: 'integer' } } } } },
  unresolved: strings, unhandled: strings,
  validation: { type: 'object', required: true, additionalProperties: false, properties: {
    semantic: { type: 'object', required: true, additionalProperties: false, properties: {
      status: { type: 'string', required: true, enum: ['not_run', 'limited'] }, scenes: { type: 'array', required: true, items: { type: 'integer' } }, reason: string } },
    visual: { type: 'object', required: true, additionalProperties: false, properties: {
      status: { type: 'string', required: true, enum: ['not_run', 'limited'] }, source_units: strings, reason: string } },
  } },
} } as const
const refinementBeat = { ...beat, properties: { ...beat.properties,
  sync_with: { type: 'integer', description: 'Action only: 1-based adjacent dialogue/OS/VO beat in the same scene; explicit refinement candidates only.' },
  synchrony_reason: { type: 'string', description: 'Explain source-backed simultaneous performance; this is not authorization to invent action.' },
} } as const
const refinementScene = { ...scene, properties: { ...scene.properties, beats: { type: 'array', required: true, items: refinementBeat } } } as const
const refinementFact = { ...fact, properties: { ...fact.properties, supplemental: supplement } } as const

/** Opt-in refinement commands; disabled deployments keep the historical model schema exactly. */
export const REQUEST_REFINEMENT = { oneOf: [
  REQUEST.oneOf[0], REQUEST.oneOf[1], REQUEST.oneOf[2], REQUEST.oneOf[3],
  { ...REQUEST.oneOf[4], properties: { ...REQUEST.oneOf[4].properties, fact: { ...refinementFact, required: true } } },
  { ...REQUEST.oneOf[5], properties: { ...REQUEST.oneOf[5].properties, facts: { type: 'array', required: true, items: refinementFact } } },
  REQUEST.oneOf[6], REQUEST.oneOf[7], REQUEST.oneOf[8],
  { ...REQUEST.oneOf[9], properties: { ...REQUEST.oneOf[9].properties,
    scenes: { type: 'array', required: true, items: refinementScene }, modification_notes: modificationNotes } },
  { ...REQUEST.oneOf[10], properties: { ...REQUEST.oneOf[10].properties, modification_notes: modificationNotes } },
  REQUEST.oneOf[11], REQUEST.oneOf[12], REQUEST.oneOf[13], REQUEST.oneOf[14], REQUEST.oneOf[15], REQUEST.oneOf[16], REQUEST.oneOf[17],
  { type: 'object', additionalProperties: false, properties: {
    method: { type: 'string', const: 'fork_refinement', required: true }, ...mutation, destination: string,
    baseline_candidate_ids: strings, scope_instructions: string, authorization_quote: string,
    consent_assessment: string, allowed_categories: { type: 'array', required: true, items: { type: 'string', enum: ['performance_detail', 'minimal_os', 'supporting_dialogue'] } },
  } },
] } as const satisfies ValueSchemaSpec

const storyLocationInput = { type: 'object', additionalProperties: false, properties: { scene: integer, beat: integer, text: string } } as const
const storyNotesInput = { type: 'object', additionalProperties: false, properties: {
  inventory_id: string, input_candidate_id: { type: 'string' },
  mapping: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
    properties: { item_id: string, outputs: { type: 'array', required: true, items: storyLocationInput } } } },
  dispositions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
    properties: { fact_id: string, disposition: { type: 'string', required: true, enum: ['retained', 'merged', 'omitted_non_story'] }, reason: string } } },
  changes: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    source: { type: 'object', additionalProperties: false, properties: { unit_id: string, fact_id: { type: 'string' } } },
    before: storyLocationInput, after: storyLocationInput, reason: string } } },
  editor_comments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { comment: string, disposition: { type: 'string', required: true, enum: ['adopted', 'partial', 'not_adopted', 'unknown'] }, reason: string, change_indices: { type: 'array', required: true, items: { type: 'integer' } } } } },
  scene_changes: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { scene: integer, reason: string } } },
  unresolved: strings,
} } as const
const semanticInput = { type: 'object', additionalProperties: false, properties: {
  event_chain: string, emotion_conflict: string, relationship_stance: string, causality_reveal: string,
  checks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
    properties: { item_id: string, status: { type: 'string', required: true, enum: ['preserved', 'deviation', 'unverified'] },
      explanation: string, source_units: strings, outputs: { type: 'array', required: true, items: storyLocationInput } } } },
  deviations: { ...strings, description: 'Remaining departures from required story events, actions, relationships, conditions, causality or reveals. Record faithful expression edits in story_notes.changes instead.' },
  unverified: { ...strings, description: 'Required story preservation judgments still unverified. Keep source identity or sampling limits in story_notes.unresolved when the output preserves those limits without unsupported claims.' },
} } as const
const storyFact = { ...refinementFact, properties: { ...refinementFact.properties, story_supplement: supplement } } as const
const storyScope = {
  work_title: string,
  videos: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
    properties: { path: string, source_version: string, episode: { type: 'integer' } } } },
  episodes: { type: 'array', required: true, items: { type: 'integer' } }, scope_instructions: string,
  authorization_quote: string, consent_assessment: string,
  allowed_categories: { type: 'array', required: true, items: { type: 'string', enum: ['performance_detail', 'minimal_os', 'supporting_dialogue'] } },
} as const
/** Default-off story commands; strict and V1 schemas remain unchanged when disabled. */
export const REQUEST_STORY = { oneOf: [
  REQUEST_REFINEMENT.oneOf[0], REQUEST_REFINEMENT.oneOf[2], REQUEST_REFINEMENT.oneOf[3],
  { ...REQUEST_REFINEMENT.oneOf[1], properties: { ...REQUEST_REFINEMENT.oneOf[1].properties, story_video_path: { type: 'string' } } },
  { ...REQUEST.oneOf[4], properties: { ...REQUEST.oneOf[4].properties, fact: { ...storyFact, required: true } } },
  { ...REQUEST.oneOf[5], properties: { ...REQUEST.oneOf[5].properties, facts: { type: 'array', required: true, items: storyFact } } },
  REQUEST.oneOf[6], REQUEST.oneOf[7], REQUEST.oneOf[8],
  { ...REQUEST_REFINEMENT.oneOf[9], properties: { ...REQUEST_REFINEMENT.oneOf[9].properties, story_notes: storyNotesInput } },
  { ...REQUEST_REFINEMENT.oneOf[10], properties: { ...REQUEST_REFINEMENT.oneOf[10].properties, story_notes: storyNotesInput } },
  { ...REQUEST.oneOf[11], properties: { ...REQUEST.oneOf[11].properties, semantic_report: semanticInput } },
  ...REQUEST_REFINEMENT.oneOf.slice(12),
  { type: 'object', additionalProperties: false, properties: {
    method: { type: 'string', const: 'init_story_faithful', required: true }, project: string, ...storyScope,
  } },
  { type: 'object', additionalProperties: false, properties: {
    method: { type: 'string', const: 'propose_story_inventory', required: true }, ...mutation, episode: integer, coverage: { ...coverage, required: true },
    not_applicable: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { dimension: { type: 'string', required: true, enum: ['event', 'action_result', 'emotion_conflict', 'relationship_stance', 'causality_reveal'] }, reason: string } } },
    items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      id: string, dimension: { type: 'string', required: true, enum: ['event', 'action_result', 'emotion_conflict', 'relationship_stance', 'causality_reveal'] },
      summary: string, critical: { type: 'boolean', required: true }, evidence: { type: 'string', required: true, enum: ['confirmed', 'unverified'] },
      fact_ids: strings, source_units: strings, depends_on: strings,
      knowledge: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
        properties: { fact_id: string, actor: string, recipients: strings } } },
    } } },
  } },
  { type: 'object', additionalProperties: false, properties: {
    method: { type: 'string', const: 'read_story_inventory', required: true }, project: string, inventory_id: string,
  } },
  { type: 'object', additionalProperties: false, properties: {
    method: { type: 'string', const: 'review_story_inventory', required: true }, ...mutation,
    inventory_id: string, inventory_sha256: string, ...review,
  } },

  { type: 'object', additionalProperties: false, properties: {
    method: { type: 'string', const: 'fork_story_faithful', required: true }, ...mutation, destination: string, before_episode: integer,
    ...storyScope,
    baseline_candidate_ids: strings,
    source_links: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { source_id: string, video_path: string } } },
  } },

] } as const satisfies ValueSchemaSpec

/** Command validated by the tool registry before project execution. */
export type ProjectRequest = InferValue<typeof REQUEST> | InferValue<typeof REQUEST_REFINEMENT> | InferValue<typeof REQUEST_STORY>
/** One submitted source classification, subject to an independent review. */
export type FactInput = Extract<InferValue<typeof REQUEST_REFINEMENT>, { method: 'propose_fact' }>['fact']
/** One structured scene submitted for an episode candidate. */
export type SceneInput = Extract<InferValue<typeof REQUEST_REFINEMENT>, { method: 'stage' }>['scenes'][number]

const nonempty = z.string().min(1).refine(value => value.trim().length > 0)
/** Durable normalized image references read through the attachment provider before model observation. */
export const IMAGE_REFERENCE = z.strictObject({
  attachmentId: nonempty, mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
  name: z.string().optional(),
  originalDimensions: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
}).transform((value): ImageAttachmentRef => ({ attachmentId: AttachmentId(value.attachmentId), mediaType: value.mediaType,
  bytes: value.bytes, width: value.width, height: value.height,
  ...(value.name === undefined ? {} : { name: value.name }),
  ...(value.originalDimensions === undefined ? {} : { originalDimensions: value.originalDimensions }) }))
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.iso.datetime()
const actorId = nonempty.transform(value => brandString<ActorId>(value))
const factId = nonempty.transform(value => brandString<FactId>(value))
const candidateId = z.string()
  .regex(/^c:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/).transform(value => brandString<CandidateId>(value))
const unitId = nonempty.transform(value => brandString<UnitId>(value))
const step = z.number().int().nonnegative().transform(SessionSeq)
/** Exact read content and strictly ordered creation/read/review model steps. */
export const SELF_CHECK_EVIDENCE = z.strictObject({
  project_id: nonempty.transform(value => brandString<ProjectId>(value)), project_revision: z.number().int().nonnegative(),
  context_sha256: digest, subject_sha256: digest, creation_step: step, review_step: step,
  reads: z.array(z.strictObject({ kind: z.enum(['source', 'fact', 'candidate', 'policy', 'inventory']), id: nonempty, sha256: digest, step })).min(1),
})
/** Durable reviewer identity, decision and optional explicit self-check evidence. */
export const REVIEW_RECORD = z.strictObject({ actor: actorId, time: timestamp, decision: z.enum(['approve', 'reject']), reason: nonempty,
  kind: z.enum(['independent', 'self-check']).optional(), evidence: SELF_CHECK_EVIDENCE.optional(),
})
/** Episode source windows and required expression channels, bound to the candidate digest. */
export const COVERAGE_RECORD = z.strictObject({
  windows: z.array(z.strictObject({ source_id: nonempty, start: z.number().int().positive(), count: z.number().int().positive(),
    interval: z.strictObject({ start_seconds: z.number().nonnegative(), end_seconds: z.number().positive() }).optional(),
  })).min(1),
  required_beats: z.array(z.strictObject({ fact_id: factId, kind: z.enum(['action', 'dialogue', 'os', 'vo']) })).min(1),
})
const unitRecord = z.strictObject({
  id: unitId, ordinal: z.number().int().positive(), text: z.string(),
  start: z.number().nonnegative().optional(), end: z.number().nonnegative().optional(), speaker_id: nonempty.optional(),
  image: IMAGE_REFERENCE.optional(),
})

/** Bounded source-preserving supplement classes; other narrative changes need a separate workflow. */
export const SUPPLEMENT_CATEGORY = z.enum(['performance_detail', 'minimal_os', 'supporting_dialogue'])
/** Real visible human-message evidence stamped by the Host, not a model confirmation flag. */
export const HUMAN_AUTHORIZATION = z.strictObject({
  source: z.literal('user'), session_id: actorId, message_id: nonempty, seq: step, message_sha256: digest,
  quote: nonempty, consent_assessment: nonempty,
})
const locatedTextRecord = z.strictObject({ scene: z.number().int().positive(), beat: z.number().int().positive(), text: nonempty })
/** Located change descriptions; semantic and visual statements are limited scope declarations, never global passes. */
export const MODIFICATION_NOTES = z.strictObject({
  changes: z.array(z.strictObject({ before: locatedTextRecord.optional(), after: locatedTextRecord.optional(), reason: nonempty })).min(1),
  editor_comments: z.array(z.strictObject({ comment: nonempty, disposition: z.enum(['adopted', 'partial', 'not_adopted', 'unknown']),
    reason: nonempty, change_indices: z.array(z.number().int().positive()) })),
  unresolved: z.array(nonempty), unhandled: z.array(nonempty),
  validation: z.strictObject({
    semantic: z.strictObject({ status: z.enum(['not_run', 'limited']), scenes: z.array(z.number().int().positive()), reason: nonempty }),
    visual: z.strictObject({ status: z.enum(['not_run', 'limited']), source_units: z.array(unitId), reason: nonempty }),
  }),
})
const supplementRecord = z.strictObject({ policy_sha256: digest, category: SUPPLEMENT_CATEGORY, authorization_sha256: digest })
const refinementRecord = z.strictObject({ policy_sha256: digest, baseline_candidate_id: candidateId, baseline_sha256: digest,
  output_content_sha256: digest,
  notes: MODIFICATION_NOTES.extend({
    input: z.strictObject({ project_id: nonempty, project_sha256: digest, candidate_id: candidateId, candidate_sha256: digest,
      episode: z.number().int().positive(), policy_version: z.literal('source-preserving-v1'), scope_instructions: nonempty }),
    output: z.strictObject({ candidate_id: candidateId, content_sha256: digest, episode: z.number().int().positive() }),
    supplements: z.array(z.strictObject({ fact_id: factId, origin: z.literal('adaptation'), category: SUPPLEMENT_CATEGORY,
      policy_sha256: digest, authorization_sha256: digest })),
    machine: z.strictObject({ rule: z.literal('located-content-and-bindings-v1'), scenes: z.array(z.number().int().positive()),
      fact_ids: z.array(factId), source_units: z.array(unitId) }),
  }),
})

/** Scoped story-faithful work grant; expression freedom never grants changed plot. */
export const STORY_POLICY = z.strictObject({
  version: z.literal('story-faithful-v2'), sha256: digest, work_title: nonempty,
  videos: z.array(z.strictObject({ path: nonempty, source_version: nonempty.transform(FsVersion),
    episode: z.number().int().positive() })).min(1),
  scope: z.strictObject({ episodes: z.array(z.number().int().positive()).min(1), instructions: nonempty }),
  allowed_categories: z.array(SUPPLEMENT_CATEGORY), authorization: HUMAN_AUTHORIZATION,
  legacy_context_sha256: digest.optional(), legacy_workflow: z.literal('video_to_screenplay').optional(),
  original_facts: z.array(z.strictObject({ id: factId, sha256: digest })).optional(),
  original_sources: z.array(z.strictObject({ id: nonempty, sha256: digest, index_sha256: digest })).optional(),
  retained_candidates: z.array(z.strictObject({ id: candidateId, sha256: digest })).optional(),
  input_candidates: z.array(nonempty).optional(),
})
const storyDimension = z.enum(['event', 'action_result', 'emotion_conflict', 'relationship_stance', 'causality_reveal'])
const storyItem = z.strictObject({
  id: nonempty, dimension: z.enum(['event', 'action_result', 'emotion_conflict', 'relationship_stance', 'causality_reveal']),
  summary: nonempty, critical: z.boolean(), evidence: z.enum(['confirmed', 'unverified']),
  fact_ids: z.array(factId).min(1), source_units: z.array(unitId).min(1), depends_on: z.array(nonempty),
  knowledge: z.array(z.strictObject({ fact_id: factId, actor: nonempty, recipients: z.array(nonempty) })),
})
/** Reviewed episode-specific invariants, with unresolved source judgments retained. */
export const STORY_INVENTORY = z.strictObject({
  id: nonempty, sha256: digest, policy_sha256: digest, scope_sha256: digest, episode: z.number().int().positive(),
  coverage: COVERAGE_RECORD, items: z.array(storyItem).min(1), not_applicable: z.array(z.strictObject({ dimension: storyDimension,
    reason: nonempty })), author: actorId,
  created_at: timestamp, created_step: step, review: REVIEW_RECORD.optional(),
  superseded_at_revision: z.number().int().nonnegative().optional(),
})
const storyLocation = locatedTextRecord
const storyChange = z.strictObject({
  source: z.strictObject({ unit_id: unitId, fact_id: factId.optional() }).optional(),
  before: storyLocation.optional(), after: storyLocation.optional(), reason: nonempty,
})
/** Exact source-to-output mapping and final-bound explanation for fresh and rewritten scripts. */
export const STORY_NOTES = z.strictObject({
  inventory_id: nonempty, input_candidate_id: candidateId.optional(),
  mapping: z.array(z.strictObject({ item_id: nonempty, outputs: z.array(storyLocation).min(1) })).min(1),
  dispositions: z.array(z.strictObject({ fact_id: factId,
    disposition: z.enum(['retained', 'merged', 'omitted_non_story']), reason: nonempty })),
  changes: z.array(storyChange).min(1),
  editor_comments: z.array(z.strictObject({ comment: nonempty, disposition: z.enum(['adopted', 'partial', 'not_adopted', 'unknown']), reason: nonempty, change_indices: z.array(z.number().int().positive()) })),
  scene_changes: z.array(z.strictObject({ scene: z.number().int().positive(), reason: nonempty })),
  unresolved: z.array(nonempty),
})
/** Candidate metadata contains actual prior candidate bytes only when a real input exists. */
export const STORY_ADAPTATION = z.strictObject({
  version: z.literal('story-faithful-v2'), policy_sha256: digest, inventory_id: nonempty, inventory_sha256: digest,
  scope_sha256: digest, output_content_sha256: digest, notes: STORY_NOTES,
  input_candidate_json: nonempty.optional(),
})
/** C-step story-preservation judgments; bindings are derived by the Host, never supplied as pass flags. */
export const SEMANTIC_INPUT = z.strictObject({
  event_chain: nonempty, emotion_conflict: nonempty, relationship_stance: nonempty, causality_reveal: nonempty,
  checks: z.array(z.strictObject({ item_id: nonempty, status: z.enum(['preserved', 'deviation', 'unverified']),
    explanation: nonempty, source_units: z.array(unitId).min(1), outputs: z.array(storyLocation).min(1) })).min(1),
  deviations: z.array(nonempty), unverified: z.array(nonempty),
})
/** Durable report binds model judgments to the exact episode and real sequential reads. */
export const SEMANTIC_REPORT = SEMANTIC_INPUT.extend({
  protocol: z.literal('story-faithful-semantic-v2'), sha256: digest,
  policy_sha256: digest, inventory_sha256: digest, scope_sha256: digest, candidate_id: candidateId, candidate_sha256: digest,
})

/** Host-issued final C-step binding; formal delivery also verifies its successful original tool log. */
export const STORY_ACCEPTANCE = z.strictObject({
  protocol: z.literal('story-faithful-acceptance-v2'), sha256: digest, session_id: actorId, review_step: step,
  candidate_id: candidateId, candidate_sha256: digest, policy_sha256: digest, inventory_sha256: digest, scope_sha256: digest,
  semantic_report_sha256: digest,
  sources: z.array(z.strictObject({ source_id: nonempty, manifest_sha256: digest, receipt_sha256: digest })).min(1),
})

/** Parser for one application-issued, attributed fact record. */
export const FACT_RECORD = z.strictObject({
  id: factId, actor: nonempty.optional(), kind: z.enum(['action', 'speech', 'thought', 'author_analysis']),
  origin: z.enum(['source', 'adaptation']), layer: z.enum(['present', 'flashback', 'dream', 'imagined', 'commentary']),
  summary: nonempty, anchors: z.array(z.strictObject({ unit_id: unitId, quote: nonempty })),
  adaptation_reason: nonempty.optional(), supplemental: supplementRecord.optional(),
  story_supplement: supplementRecord.optional(), proposer: actorId, created_at: timestamp,
  created_step: step.optional(),
  review: REVIEW_RECORD.optional(),
  withdrawal: REVIEW_RECORD.omit({ decision: true }).optional(),
})
/** One complete drafted scene parsed from candidate records or a bounded JSON file. */
export const SCENE_RECORD = z.strictObject({
  location: nonempty, time: nonempty, layer: z.enum(['present', 'flashback', 'dream', 'imagined']),
  setting: z.enum(['内', '外', '内外']).optional(),
  transition: z.enum(['opening', 'continuous', 'cut', 'enter_flashback', 'return_present']),
  characters: z.array(nonempty), voice_only_characters: z.array(nonempty).optional(), beats: z.array(z.strictObject({
    kind: z.enum(['action', 'dialogue', 'os', 'vo']), actor: nonempty.optional(), text: nonempty,
    fact_ids: z.array(factId), requires_knowledge: z.array(factId), witnesses: z.array(nonempty),
    audible_in_scene: z.boolean().optional(), hook: z.boolean().optional(),
    sync_with: z.number().int().positive().optional(), synchrony_reason: nonempty.optional(),
  })),
})
/** Parser for an application-issued structured episode version. */
export const CANDIDATE_RECORD = z.strictObject({
  id: candidateId, sha256: digest, episode: z.number().int().positive(), base_episode: z.number().int().nonnegative(),
  author: actorId, created_at: timestamp, created_step: step.optional(),
  scenes: z.array(SCENE_RECORD).min(1),
  coverage: COVERAGE_RECORD.optional(), refinement: refinementRecord.optional(), story_adaptation: STORY_ADAPTATION.optional(),
  source_ids: z.array(nonempty).optional(),
  review: REVIEW_RECORD.extend({ zero_action_reason: nonempty.optional(), semantic_report: SEMANTIC_REPORT.optional(),
    story_acceptance: STORY_ACCEPTANCE.optional() }).optional(), committed_at: timestamp.optional(),
})

const observation = z.strictObject({ time: z.number().nonnegative(), reasons: z.array(nonempty) })
/** Sampled inspection scope and outstanding observations; never continuous visual coverage. */
export const VIDEO_SOURCE = z.strictObject({
  path: nonempty, source_version: nonempty.transform(FsVersion), inspection: z.literal('sampled_frames'),
  duration_seconds: z.number().positive(),
  samples: z.array(z.strictObject({ requested_seconds: z.number().nonnegative(), timestamp_seconds: z.number().nonnegative() })),
  interval: z.strictObject({ start_seconds: z.number().nonnegative(), end_seconds: z.number().positive() }).optional(),
  sampling_plan: z.strictObject({ strategy: z.literal('scene_dialogue'), selected: z.array(observation), deferred: z.array(observation) }).optional(),
})


/** Immutable refinement fork policy; complete candidate snapshots retain the actual input version. */
export const REFINEMENT_POLICY = z.strictObject({
  version: z.literal('source-preserving-v1'), sha256: digest,
  source_project: z.strictObject({ id: nonempty, path: nonempty, revision: z.number().int().nonnegative(), sha256: digest }),
  baselines: z.array(CANDIDATE_RECORD).min(1),
  retained_candidates: z.array(z.strictObject({ id: candidateId, sha256: digest })),
  original_facts: z.array(z.strictObject({ id: factId, sha256: digest })),
  original_sources: z.array(z.strictObject({ id: nonempty, sha256: digest })),
  scope: z.strictObject({ episodes: z.array(z.number().int().positive()).min(1), instructions: nonempty }),
  allowed_categories: z.array(SUPPLEMENT_CATEGORY),
  authorization: HUMAN_AUTHORIZATION,
})

/** File-format parser; unknown fields, malformed metadata, and unsupported versions fail on read. */
export const PROJECT_FILE = z.strictObject({
  format_version: z.literal(1), id: nonempty.transform(value => brandString<ProjectId>(value)), revision: z.number().int().nonnegative(),
  mode: z.enum(['faithful', 'adaptation']), instructions: nonempty, created_at: timestamp, updated_at: timestamp,
  workflow: z.literal('video_to_screenplay').optional(), review_mode: z.literal('self-check').optional(),
  refinement: REFINEMENT_POLICY.optional(), story_policy: STORY_POLICY.optional(), story_inventories: z.array(STORY_INVENTORY).optional(),
  parent: z.strictObject({ id: nonempty.transform(value => brandString<ProjectId>(value)), path: nonempty,
    revision: z.number().int().nonnegative(), before_episode: z.number().int().positive(), sha256: digest }).optional(),
  sources: z.array(z.strictObject({ id: nonempty.transform(value => brandString<SourceId>(value)), path: nonempty, sha256: digest, kind: z.enum(['text', 'transcript', 'video_inspection']), units: z.array(unitRecord), video: VIDEO_SOURCE.optional(), story_video_path: nonempty.optional(), trusted_video_manifest: z.json().optional(), trusted_video_receipt: TRUSTED_VIDEO_INSPECTION_RECEIPT.optional() })),
  facts: z.array(FACT_RECORD), candidates: z.array(CANDIDATE_RECORD), accepted: z.array(candidateId),
})

/** Validated project artifact, separate from released Session events. */
export type ProjectFile = z.infer<typeof PROJECT_FILE>
/** One validated immutable imported source. */
export type ProjectSource = ProjectFile['sources'][number]

const segments = z.array(z.object({
  start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string(),
  speaker_id: nonempty.optional(),
})).min(1)
/** Accept native audio_transcribe arrays and account job wrappers without changing segment order. */
export const TRANSCRIPT = z.union([segments, z.object({ segments })]).transform(value => Array.isArray(value) ? value : value.segments)

/** Actual sampled-frame manifests; image metadata is not an automatic claim about actions or identities. */
export const VIDEO_INSPECTION = VIDEO_SOURCE.omit({ samples: true }).loose().extend({ verified_readback: z.literal(true),
  frames: z.array(z.object({ requested_seconds: z.number().nonnegative(),
    timestamp_seconds: z.number().nonnegative(), image: IMAGE_REFERENCE })).min(1),
})
