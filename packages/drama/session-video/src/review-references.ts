/** Local screenplay, casting and delivery evidence for the selected production coordinates. */
import { createHash } from 'node:crypto'
import { extname, join } from 'node:path'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { stableSha256, storyboardMaterials } from '@deepseek-ai/dsh-jubian-api'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { record } from './sources.ts'
import type { SessionVideoProduction } from './types.ts'

const positiveId = z.number().int().positive()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const productionReceipt = z.object({ method: z.enum(['preview', 'read', 'update']), script_id: positiveId,
  episode: positiveId, plan_path: z.string().min(1), fingerprint: sha256,
  source_path: z.string().min(1), source_sha256: sha256 })
const recordedContent = z.array(z.unknown()).catch([])
const castingMatch = z.object({ shot: positiveId, kind: z.enum(['character', 'voice']), name: z.string(),
  state: z.string().optional(), character_id: z.string().optional(), voice_period_id: z.string().optional(),
  selected_asset_id: positiveId.nullable(), selection_basis: z.enum(['explicit', 'unique_metadata', 'unresolved', 'omitted']) })
const planSchema = z.object({ operation: z.literal('muse_production'), version: z.literal(1), fingerprint: sha256,
  script_id: positiveId, episode: positiveId, episode_id: positiveId, source_path: z.string(), source_sha256: sha256,
  matches: z.array(z.unknown()), packages: z.array(z.object({ index: positiveId, storyboard_id: positiveId.nullable(),
    shots: z.array(positiveId) })) })

const deliveryFields = z.object({ width: positiveId.optional(), height: positiveId.optional(),
  fps: z.number().positive().optional(), min_bitrate_mbps: z.number().positive().optional(),
  require_source_review: z.boolean().optional(), subtitle: z.object({ require_no_punctuation: z.boolean().optional(),
    require_speech_coverage: z.boolean().optional() }).optional(),
  audio: z.object({ require_music_decision: z.boolean().optional() }).optional(),
  max_effective_chars_per_shot: positiveId.optional() })
const projectSchema = z.object({ jubian_script_id: positiveId.optional(), delivery: deliveryFields.optional(),
  project_bible: z.object({ jubian_script_id: positiveId.optional(), style: z.string().optional(),
    visual_medium: z.enum(['animation_3d', 'photorealistic']).optional(), aspect_ratio: z.string().optional(),
    video: z.object({ resolution: z.string().optional() }).optional(), delivery: deliveryFields.optional() }).optional() })

type EvidenceGap = { readonly status: 'unavailable'; readonly reason: string }
type Screenplay = EvidenceGap | {
  readonly status: 'available'
  readonly basis: 'recorded_production' | 'user_attachment' | 'user_reference'
  readonly name: string
  readonly sha256: string
  readonly text: string
  readonly authored_shots: readonly number[]
}
type CharacterBindings = EvidenceGap | {
  readonly status: 'available'
  readonly basis: 'planned_asset_choices'
  readonly matches: readonly z.infer<typeof castingMatch>[]
}
type SavedBindings = EvidenceGap | {
  readonly status: 'available'
  readonly basis: 'recorded_storyboard_readback'
  readonly storyboard_id: number
  readonly assets: readonly {
    readonly material_key: string
    readonly name: string | null
    readonly type: 'image' | 'audio' | null
    readonly asset_id: number | null
    readonly material_id: string | null
  }[]
}
type Delivery = EvidenceGap | {
  readonly status: 'available'
  readonly basis: 'project_config'
  readonly footage: {
    readonly aspect_ratio?: string | undefined
    readonly visual_medium?: string | undefined
    readonly style?: string | undefined
    readonly generation_resolution?: string | undefined
    readonly max_effective_chars_per_shot?: number | undefined
  }
  readonly final_episode?: Omit<z.infer<typeof deliveryFields>, 'max_effective_chars_per_shot'> | undefined
}

interface ReviewReferences {
  readonly screenplay: Screenplay
  readonly character_bindings: CharacterBindings
  readonly saved_bindings: SavedBindings
  readonly delivery: Delivery
}

function unavailable(reason: string): EvidenceGap { return { status: 'unavailable', reason } }

function parse(text: string): unknown { return JSON.parse(text) }

function digest(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex') }

function isScreenplay(path: string): boolean { return ['.txt', '.md', '.fountain'].includes(extname(path).toLowerCase()) }

async function readWorkspaceFile(ctx: Context, root: FsTarget, path: string, signal: AbortSignal, limit: number) {
  const target = await ctx.fs.resolve(path, { cwd: root.displayPath, signal })
  if (!ctx.fs.contains(root, target)) throw Error('Reference is outside the conversation workspace')
  const before = await ctx.fs.stat(target, signal)
  if (before?.type !== 'file' || (before.size !== undefined && before.size > limit)) throw Error('Reference is unavailable')
  const bytes = await ctx.fs.readBytes(target, signal, limit)
  if ((await ctx.fs.stat(target, signal))?.version !== before.version) throw Error('Reference changed during review')
  const resolved = await ctx.fs.resolve(path, { cwd: root.displayPath, signal })
  if (resolved.targetKey !== target.targetKey) throw Error('Reference moved during review')
  return { bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), target }
}

function recordedObject(value: unknown, limit: number): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return record(value)
  if (Buffer.byteLength(value) > limit) return undefined
  try { return record(parse(value)) }
  catch (_invalidJson) { return undefined }
}

function* recordedToolResults(events: readonly { readonly type: string; readonly data: unknown }[], name: string, limit: number) {
  const pending = new Map<unknown, Record<string, unknown>>()
  function* texts(content: unknown, args: Record<string, unknown>) {
    for (const item of recordedContent.parse(content)) {
      const block = record(item)
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      const result = recordedObject(block.text, limit)
      if (result !== undefined) yield { args, result }
    }
  }
  for (const event of events) {
    const data = record(event.data)
    if (event.type === 'tool/call' && data?.name === name && typeof data.callId === 'string') {
      const requested = recordedObject(data.arguments, limit)
      if (requested !== undefined) pending.set(data.callId, requested)
    }
    if (event.type === 'tool/result') {
      const message = record(data?.message)
      const callId = message?.toolCallId
      const requested = pending.get(callId)
      pending.delete(callId)
      if (requested !== undefined && message?.isError === false) yield* texts(message.content, requested)
    }
    if (event.type === 'tool/ptc-dispatch' && data?.name === name && data.isError === false) {
      const requested = recordedObject(data.arguments, limit)
      if (requested !== undefined) yield* texts(data.content, requested)
    }
  }
}

function recordedReceipt(events: readonly SessionEvent[], production: SessionVideoProduction, limit: number) {
  let latest: z.infer<typeof productionReceipt> | undefined
  for (const { args, result } of recordedToolResults(events, 'muse_production', limit)) {
    const receipt = productionReceipt.safeParse(result)
    if (receipt.success && receipt.data.method === args.method && receipt.data.script_id === production.scriptId
      && receipt.data.episode === production.episodeNumber) latest = receipt.data
  }
  return latest
}

function providerId(value: unknown): number | undefined {
  const parsed = positiveId.safeParse(typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value)
  return parsed.success ? parsed.data : undefined
}

function savedBindings(events: readonly SessionEvent[], production: SessionVideoProduction | undefined, limit: number): SavedBindings {
  if (production?.storyboardId === undefined || production.episodeId === undefined) {
    return unavailable('The video has no exact episode and storyboard identities for a saved asset check')
  }
  let latest: Record<string, unknown> | undefined
  for (const { args, result } of recordedToolResults(events, 'jubian_storyboard', limit)) {
    if (args.method !== 'get' || providerId(args.storyboard_id) !== production.storyboardId) continue
    const card = record(result.storyboard), snapshot = record(card?.snapshot)
    if (snapshot && providerId(card?.storyboard_id) === production.storyboardId && providerId(card?.script_id) === production.scriptId
      && providerId(snapshot.episodeId) === production.episodeId) latest = snapshot
  }
  if (!latest) return unavailable('No saved card readback for this exact project, episode and storyboard is recorded')
  try {
    const { materials } = storyboardMaterials(latest)
    const assets = materials.map((material) => {
      const type = z.enum(['image', 'audio']).safeParse(material.materialType)
      const materialId = z.union([positiveId, z.string().regex(/^[\w.-]+$/u)]).safeParse(material.assetId)
      return { material_key: z.string().min(1).parse(material.materialKey),
        name: z.string().catch('').parse(material.materialName ?? material.fileName) || null,
        type: type.success ? type.data : null,
        asset_id: providerId(material.materialAssetId) ?? null, material_id: materialId.success ? String(materialId.data) : null }
    })
    return { status: 'available', basis: 'recorded_storyboard_readback', storyboard_id: production.storyboardId, assets }
  } catch (_unavailableMaterials) { return unavailable('The recorded storyboard materials are unavailable or invalid') }
}

function selectedSections(text: string, shotNumbers: readonly number[] | undefined) {
  if (!shotNumbers?.length) return undefined
  const markers = [...text.matchAll(/^【镜头(\d+)】[ \t]*\r?$/gmu)]
  const headings = [...text.matchAll(/^场次[ \t]*\d+[-－]\d+[：:][ \t]*[^\r\n]+/gmu)]
  const sections = markers.flatMap((marker, index) => {
    const shot = Number(marker[1])
    if (!shotNumbers.includes(shot)) return []
    const nextMarker = markers[index + 1]?.index ?? text.length
    const nextHeading = headings.find(heading => heading.index > marker.index && heading.index < nextMarker)
    const scene = headings.findLast(heading => heading.index < marker.index)
    const section = text.slice(marker.index, nextHeading?.index ?? nextMarker).trimEnd()
    return [{ shot, text: scene === undefined ? section : `${scene[0]}\n${section}` }]
  })
  return sections.length === new Set(shotNumbers).size && new Set(sections.map(section => section.shot)).size === sections.length
    ? { text: sections.map(section => section.text).join('\n\n'), authored_shots: sections.map(section => section.shot) }
    : undefined
}

async function productionReferences(ctx: Context, root: FsTarget | undefined, events: readonly SessionEvent[],
  production: SessionVideoProduction | undefined, signal: AbortSignal, limit: number):
Promise<Pick<ReviewReferences, 'screenplay' | 'character_bindings'>> {
  const receipt = production?.episodeNumber === undefined ? undefined : recordedReceipt(events, production, limit)
  if (!receipt || !root || !production) {
    const gap = unavailable('No production plan for this exact project and episode is recorded in the conversation')
    return { screenplay: gap, character_bindings: gap }
  }
  let screenplay: Screenplay = unavailable('The recorded screenplay is missing, changed, unreadable or exceeds the review limit')
  try {
    const source = await readWorkspaceFile(ctx, root, receipt.source_path, signal, limit)
    if (digest(source.bytes) === receipt.source_sha256 && source.text.trim().length > 0) {
      const selected = selectedSections(source.text, production.shotNumbers)
      screenplay = selected === undefined ? unavailable('The selected range has no unique authored shot sections in the recorded screenplay')
        : { status: 'available', basis: 'recorded_production', name: source.target.displayPath, sha256: receipt.source_sha256, ...selected }
    }
  } catch (_unavailableReference) { signal.throwIfAborted() }
  let character_bindings: CharacterBindings = unavailable('No current casting record is available for the selected authored shots')
  try {
    const expected = await ctx.fs.resolve(join('.muse', 'production', `${receipt.fingerprint}.json`), { cwd: root.displayPath, signal })
    const source = await readWorkspaceFile(ctx, root, receipt.plan_path, signal, limit)
    const planDocument = record(parse(source.text))
    if (!planDocument) return { screenplay, character_bindings }
    const plan = planSchema.parse(planDocument)
    const { fingerprint: _fingerprint, ...body } = planDocument
    if (source.target.targetKey !== expected.targetKey || stableSha256(body) !== receipt.fingerprint
      || plan.fingerprint !== receipt.fingerprint || plan.source_sha256 !== receipt.source_sha256
      || plan.source_path !== receipt.source_path
      || plan.script_id !== receipt.script_id || plan.episode !== receipt.episode
      || (production.episodeId !== undefined && plan.episode_id !== production.episodeId)) {
      return { screenplay, character_bindings }
    }
    const plans = plan.packages.filter(item => (production.packageIndex === undefined || item.index === production.packageIndex)
      && (production.storyboardId === undefined || item.storyboard_id === production.storyboardId
        || (item.storyboard_id === null && production.packageIndex !== undefined)))
    const packageShots = plans.length === 1 ? plans[0]?.shots : undefined
    const packagePinned = production.packageIndex !== undefined || production.storyboardId !== undefined
    const shots = packagePinned && packageShots === undefined ? undefined
      : production.shotNumbers?.filter(shot => packageShots === undefined || packageShots.includes(shot))
    const matches = plan.matches.flatMap((item) => {
      const match = castingMatch.safeParse(item)
      return match.success && shots?.includes(match.data.shot) ? [match.data] : []
    })
    if (screenplay.status === 'available' && matches.length > 0) {
      character_bindings = { status: 'available', basis: 'planned_asset_choices', matches }
    }
  } catch (_unavailablePlan) { signal.throwIfAborted() }
  return { screenplay, character_bindings }
}

function latestUserReferences(events: readonly SessionEvent[]) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user' || 'principal' in event.data.source) continue
    const attached = new Map<string, FileAttachmentRef>()
    const paths = new Set<string>()
    for (const block of event.data.content) {
      if (block.type === 'file' && isScreenplay(block.attachment.name)) attached.set(block.attachment.attachmentId, block.attachment)
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(/(?:^|\s)@(?:"([^"\r\n]+)"|([^\s]+))/gu)) {
        const path = match[1] ?? match[2]
        if (path && isScreenplay(path) && !/^[a-z]+:\/\//iu.test(path) && !path.includes('\0')) paths.add(path)
      }
    }
    if (attached.size > 0 || paths.size > 0) return { attached: [...attached.values()], paths: [...paths] }
  }
  return { attached: [], paths: [] }
}

async function userScreenplay(ctx: Context, root: FsTarget | undefined, events: readonly SessionEvent[],
  signal: AbortSignal, limit: number): Promise<Screenplay | undefined> {
  const { attached, paths } = latestUserReferences(events)
  if (attached.length + paths.length === 0) return undefined
  if (attached.length + paths.length > 1) return unavailable('More than one screenplay reference was supplied; identify one as the review basis')
  const file = attached[0]
  try {
    if (file && file.bytes <= limit) {
      const parts: Uint8Array[] = []
      let read = 0
      for await (const chunk of ctx.attachments.readFileStream(file, signal)) {
        signal.throwIfAborted()
        read += chunk.byteLength
        if (read > file.bytes) throw Error('Attachment size does not match')
        parts.push(chunk)
      }
      const data = Buffer.concat(parts, read), hash = digest(data)
      if (read !== file.bytes || file.attachmentId !== `sha256:${hash}`) throw Error('Attachment identity does not match')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
      if (text.trim()) return { status: 'available', basis: 'user_attachment', name: file.name, sha256: hash, text, authored_shots: [] }
    }
    if (paths[0] && root) {
      const source = await readWorkspaceFile(ctx, root, paths[0], signal, limit)
      if (source.text.trim()) return { status: 'available', basis: 'user_reference', name: source.target.displayPath,
        sha256: digest(source.bytes), text: source.text, authored_shots: [] }
    }
  } catch (_unavailableReference) { signal.throwIfAborted() }
  return unavailable('The supplied screenplay is missing, unreadable, outside the workspace or exceeds the review limit')
}

async function projectDelivery(ctx: Context, root: FsTarget | undefined, production: SessionVideoProduction | undefined,
  signal: AbortSignal, limit: number): Promise<Delivery> {
  if (!root) return unavailable('This conversation has no project directory')
  try {
    const config = await readWorkspaceFile(ctx, root, 'project_config.json', signal, limit)
    const project = projectSchema.parse(parse(config.text)), bible = project.project_bible
    const scriptId = project.jubian_script_id ?? bible?.jubian_script_id
    const conflicting = project.jubian_script_id !== undefined && bible?.jubian_script_id !== undefined
      && project.jubian_script_id !== bible.jubian_script_id
    if (conflicting || (production && scriptId !== production.scriptId)) {
      return unavailable('The workspace project does not match the selected video project')
    }
    const { max_effective_chars_per_shot, ...final_episode } = bible?.delivery ?? {}
    const footage = { aspect_ratio: bible?.aspect_ratio, visual_medium: bible?.visual_medium, style: bible?.style,
      generation_resolution: bible?.video?.resolution,
      max_effective_chars_per_shot: max_effective_chars_per_shot ?? project.delivery?.max_effective_chars_per_shot }
    if (Object.values(footage).every(value => value === undefined) && Object.keys(final_episode).length === 0) {
      return unavailable('The project has no recorded delivery requirements')
    }
    return { status: 'available', basis: 'project_config', footage,
      ...(Object.keys(final_episode).length > 0 ? { final_episode } : {}) }
  } catch (_unavailableConfig) { signal.throwIfAborted() }
  return unavailable('The workspace project configuration is missing, unreadable or exceeds the review limit')
}

/**
 * Read recorded production evidence and owner-supplied screenplay references without probing other files.
 * @param ctx - Conversation query, attachment and filesystem services.
 * @param session - Conversation that owns the selected video and evidence.
 * @param production - Exact video project, episode and available authored shot coordinates.
 * @param signal - Lifetime of the current review.
 * @param maxResultBytes - Maximum complete serialized bytes for returned evidence.
 * @param maxReadBytes - Maximum bytes per source file or recorded production receipt.
 * @returns References or reasons they are unavailable. Project text is evidence, not instructions.
 */
export async function reviewReferences(ctx: Context, session: Session, production: SessionVideoProduction | undefined,
  signal: AbortSignal, maxResultBytes: number, maxReadBytes = maxResultBytes): Promise<ReviewReferences> {
  signal.throwIfAborted()
  const { events } = await ctx.sessionQuery.readSession(session.id)
  let root: FsTarget | undefined
  try {
    if (session.header.cwd) root = await ctx.fs.resolve(session.header.cwd, { signal })
  } catch (_unavailableWorkspace) { signal.throwIfAborted() }
  const references = await productionReferences(ctx, root, events, production, signal, maxReadBytes)
  const screenplay = references.screenplay.status === 'available' ? references.screenplay
    : await userScreenplay(ctx, root, events, signal, maxReadBytes) ?? references.screenplay
  const delivery = await projectDelivery(ctx, root, production, signal, maxReadBytes)
  const gap = unavailable('The review references exceed the tool result limit')
  const offered = { screenplay, character_bindings: references.character_bindings, delivery,
    saved_bindings: savedBindings(events, production, maxReadBytes) }
  let result: ReviewReferences = { screenplay: gap, character_bindings: gap, saved_bindings: gap, delivery: gap }
  for (const key of ['screenplay', 'character_bindings', 'saved_bindings', 'delivery'] as const) {
    const next = { ...result, [key]: offered[key] }
    if (Buffer.byteLength(JSON.stringify(next)) <= maxResultBytes) result = next
  }
  signal.throwIfAborted()
  return result
}
