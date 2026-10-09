/** Validated screenplay sources, candidate records, and model commands. @module screenplay-project/schema */

import { z } from 'zod'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
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
      type: 'object', additionalProperties: false, properties: { source_id: string, start: integer, count: integer },
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
      files: { type: 'array', items: { type: 'string' }, required: true },
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

/** Command validated by the tool registry before project execution. */
export type ProjectRequest = InferValue<typeof REQUEST>
/** One submitted source classification, subject to an independent review. */
export type FactInput = Extract<ProjectRequest, { method: 'propose_fact' }>['fact']
/** One structured scene submitted for an episode candidate. */
export type SceneInput = Extract<ProjectRequest, { method: 'stage' }>['scenes'][number]

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
const reviewRecord = z.strictObject({ actor: actorId, time: timestamp, decision: z.enum(['approve', 'reject']), reason: nonempty })
/** Episode source windows and required expression channels, bound to the candidate digest. */
export const COVERAGE_RECORD = z.strictObject({
  windows: z.array(z.strictObject({ source_id: nonempty, start: z.number().int().positive(), count: z.number().int().positive() })).min(1),
  required_beats: z.array(z.strictObject({ fact_id: factId, kind: z.enum(['action', 'dialogue', 'os', 'vo']) })).min(1),
})
const unitRecord = z.strictObject({
  id: unitId, ordinal: z.number().int().positive(), text: z.string(),
  start: z.number().nonnegative().optional(), end: z.number().nonnegative().optional(), speaker_id: nonempty.optional(),
  image: IMAGE_REFERENCE.optional(),
})
/** Parser for one application-issued, attributed fact record. */
export const FACT_RECORD = z.strictObject({
  id: factId, actor: nonempty.optional(), kind: z.enum(['action', 'speech', 'thought', 'author_analysis']),
  origin: z.enum(['source', 'adaptation']), layer: z.enum(['present', 'flashback', 'dream', 'imagined', 'commentary']),
  summary: nonempty, anchors: z.array(z.strictObject({ unit_id: unitId, quote: nonempty })),
  adaptation_reason: nonempty.optional(), proposer: actorId, created_at: timestamp,
  review: reviewRecord.optional(),
  withdrawal: z.strictObject({ actor: actorId, time: timestamp, reason: nonempty }).optional(),
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
  })),
})
/** Parser for an application-issued structured episode version. */
export const CANDIDATE_RECORD = z.strictObject({
  id: candidateId, sha256: digest, episode: z.number().int().positive(), base_episode: z.number().int().nonnegative(),
  author: actorId, created_at: timestamp, scenes: z.array(SCENE_RECORD).min(1),
  coverage: COVERAGE_RECORD.optional(),
  review: reviewRecord.extend({ zero_action_reason: nonempty.optional() }).optional(), committed_at: timestamp.optional(),
})

/** File-format parser; unknown fields, malformed metadata, and unsupported versions fail on read. */
export const PROJECT_FILE = z.strictObject({
  format_version: z.literal(1), id: nonempty.transform(value => brandString<ProjectId>(value)), revision: z.number().int().nonnegative(),
  mode: z.enum(['faithful', 'adaptation']), instructions: nonempty, created_at: timestamp, updated_at: timestamp,
  workflow: z.literal('video_to_screenplay').optional(),
  parent: z.strictObject({ id: nonempty.transform(value => brandString<ProjectId>(value)), path: nonempty,
    revision: z.number().int().nonnegative(), before_episode: z.number().int().positive(), sha256: digest }).optional(),
  sources: z.array(z.strictObject({ id: nonempty.transform(value => brandString<SourceId>(value)), path: nonempty, sha256: digest, kind: z.enum(['text', 'transcript', 'video_inspection']), units: z.array(unitRecord) })),
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
export const VIDEO_INSPECTION = z.object({ path: nonempty, source_version: nonempty.transform(FsVersion),
  inspection: z.literal('sampled_frames'), verified_readback: z.literal(true), duration_seconds: z.number().positive(),
  frames: z.array(z.object({ requested_seconds: z.number().nonnegative(),
    timestamp_seconds: z.number().nonnegative(), image: IMAGE_REFERENCE })).min(1),
})
