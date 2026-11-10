/** Strict data-only descriptor consumed by the standalone episode worker. */
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import { Config as RendererConfig, resolveSettings } from '@deepseek-ai/dsh-tool-episode-render'
import { attemptIdentitySchema, episodeHashSchema, readEpisodeBytes } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import type { EpisodeExecutionId, EpisodeRendererGeneration, Sha256 } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import { generationSessionBindingSchema } from '@deepseek-ai/dsh-tool-jubian/generation-binding'

/** Validate through the renderer owner's Standard Schema adapter exactly once.
 * @param value - Deployment or worker JSON configuration.
 * @returns The renderer's validated, default-resolved Config.
 */
export function parseEpisodeRendererConfig(value: unknown): RendererConfig {
  const parsed = RendererConfig['~standard'].validate(value)
  if ('then' in parsed) throw new Error('Episode renderer configuration must validate synchronously')
  if (parsed.issues !== undefined) throw new Error('Episode renderer configuration is invalid: ' + parsed.issues.map(issue => issue.message).join('; '))
  // Schemastery's Standard Schema property erases its Config output type.
  return parsed.value as RendererConfig
}

const path = z.string().min(1).refine(isAbsolute, 'Episode path must be absolute')
/** Exact stable facts for one private or runtime file. */
export const episodeFileSchema = z.strictObject({ path, sha256: episodeHashSchema, bytes: z.number().int().nonnegative() })
/** Measured runtime inputs remain distinct from project-owned staged files. */
export const episodeRuntimeFileSchema = episodeFileSchema.extend({ owner: z.enum(['renderer', 'media', 'font']) })
const rendererIdentity = z.strictObject({ generation: z.uuid().transform(value => brandString<EpisodeRendererGeneration>(value)),
  configurationSha256: episodeHashSchema, codeSha256: episodeHashSchema })
/** Full verified candidate data written only before the matching completed drain proof. */
export const episodeCandidateSchema = episodeFileSchema.extend({ width: z.number().int().positive(), height: z.number().int().positive(),
  durationUs: z.number().int().positive(), video: z.literal(true), audio: z.literal(true) })

/** Configuration and runtime facts whose stable hash identifies the actual capture. */
export const episodeConfigurationSchema = z.strictObject({
  projectDir: path,
  episode: z.number().int().positive().max(99),
  digest: episodeHashSchema,
  config: z.unknown().transform(parseEpisodeRendererConfig),
  runtimeInputs: z.array(episodeRuntimeFileSchema).min(1),
  projectInputs: z.array(episodeFileSchema).min(1),
})

/** Data-only worker request; its own SHA belongs to the separate execution identity. */
export const episodeDescriptorSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('approved-episode-render'),
  identity: attemptIdentitySchema,
  execution: z.uuid().transform(value => brandString<EpisodeExecutionId>(value)),
  renderer: rendererIdentity,
  originalProject: path, attemptRoot: path, stageRoot: path,
  configuration: episodeConfigurationSchema,
  config: z.unknown().transform(parseEpisodeRendererConfig),
  stagedFiles: z.array(episodeFileSchema).min(1),
  projectFiles: z.array(episodeFileSchema.extend({ originalPath: path,
    role: z.enum(['project', 'plan', 'timeline', 'subtitle', 'mix-profile', 'bgm']) })).min(1),
  stagedSources: z.array(episodeFileSchema.extend({ shot: z.number().int().positive(),
    idempotencyKey: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/u) })).min(1),
  timelinePath: path, subtitlePath: path, mixProfilePath: path, bgmPath: path.optional(),
  endingAudio: path.optional(), endingEffect: path.optional(),
  candidatePath: path, candidateFactsPath: path,
  lastShot: z.number().int().positive().max(500),
  retry: z.enum(['initial', 'host-disconnect-recovery', 'explicit-retry']),
})

/** Parsed data-only worker input. */
export type EpisodeRenderDescriptor = z.infer<typeof episodeDescriptorSchema>

/** A data claim only: the live Host must authenticate its Session and file facts. */
export const episodeDescriptorV2Schema = episodeDescriptorSchema.extend({
  version: z.literal(2),
  sourceClaim: z.strictObject({
    identity: attemptIdentitySchema,
    execution: z.uuid().transform(value => brandString<EpisodeExecutionId>(value)),
    sessionId: z.string().min(1),
    workspaceRoot: path,
    workspaceId: z.string().min(1).optional(),
    subtitleClock: z.enum(['present', 'absent']),
    files: z.array(z.strictObject({
      originalPath: path, stagedPath: path, sha256: episodeHashSchema,
      bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      aliases: z.array(path).max(128).optional(),
      roles: z.array(z.enum(['source-manifest', 'selected-video', 'source-audio', 'master-audio',
        'review-record', 'package-record', 'ocr', 'inspection', 'subtitle-clock', 'review-frame', 'download-receipt'])).min(1),
    })).min(1).max(4096),
    directories: z.array(z.strictObject({ originalPath: path, entries: z.array(z.string().min(1)).max(4096) })).min(1).max(64),
    bindings: z.array(z.strictObject({
      mediaOriginalPath: path, ocrOriginalPath: path, inspectionOriginalPath: path, reviewId: z.string().min(1),
    })).min(1).max(4096),
  }),
})

/** Prepared episode files captured at admission; the original v1 descriptor remains unchanged. */
export const episodeClockInputsSchema = z.strictObject({
  clock: episodeFileSchema.optional(), manifest: episodeFileSchema, master: episodeFileSchema.optional(),
  shots: z.array(z.strictObject({ shot: z.number().int().positive(), video: episodeFileSchema, audio: episodeFileSchema })).min(1),
})
/** Independent descriptor for prepared audio and an optional generated subtitle clock. */
export const episodeDescriptorV3Schema = episodeDescriptorSchema.extend({
  version: z.literal(3), clockInputs: episodeClockInputsSchema,
  clockStage: z.strictObject({ clockPath: path.optional(), manifestPath: path, masterPath: path.optional(),
    audio: z.array(z.strictObject({ shot: z.number().int().positive(), originalPath: path, stagedPath: path })).min(1) }),
})
/** Source-review observations bound into a version-four renderer configuration. */
export const episodeSourceEvidenceSchema = z.strictObject({
  sessions: z.array(generationSessionBindingSchema).min(1).max(4096),
  sourceQaSha256: episodeHashSchema,
  selectedPaths: z.array(path).min(1).max(500),
  files: z.array(episodeFileSchema).min(1).max(4096),
  directories: episodeDescriptorV2Schema.shape.sourceClaim.shape.directories,
  bindings: z.array(z.strictObject({ sessionId: z.string().min(1), reviewId: z.string().min(1),
    mediaPath: path, mediaSha256: episodeHashSchema, ocrPath: path, ocrSha256: episodeHashSchema,
    inspectionPath: path, inspectionSha256: episodeHashSchema })).min(1).max(4096),
})

/** Clock and source evidence successor; the descriptor itself does not grant authority. */
export const episodeDescriptorV4Schema = episodeDescriptorV3Schema.extend({
  version: z.literal(4), sourceEvidence: episodeSourceEvidenceSchema,
  sourceClaim: episodeDescriptorV2Schema.shape.sourceClaim.extend({
    files: z.array(episodeDescriptorV2Schema.shape.sourceClaim.shape.files.element.extend({
      roles: z.array(z.enum(['source-manifest', 'selected-video', 'source-audio', 'master-audio',
        'review-record', 'package-record', 'ocr', 'inspection', 'subtitle-clock', 'review-frame', 'download-receipt',
        'review-evidence'])).min(1),
    })).min(1).max(4096),
  }),
})
/** Version-four decoded facts require separate live Host authority. */
export type EpisodeRenderDescriptorV4 = z.infer<typeof episodeDescriptorV4Schema>

/** Decoded version-three facts, not a Session or source-review authorization. */
export type EpisodeRenderDescriptorV3 = z.infer<typeof episodeDescriptorV3Schema>

/** Version-two data, not a verified claim or permission to render. */
export type EpisodeRenderDescriptorV2 = z.infer<typeof episodeDescriptorV2Schema>

/** Test whether a captured absolute path belongs to the private execution root.
 * @param root - Canonical private directory.
 * @param selected - Validated absolute file path.
 * @returns Whether the path is a proper child of that directory.
 */
export function insideEpisodeRoot(root: string, selected: string): boolean {
  const child = relative(root, selected)
  return child !== '' && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}

/** Hash the canonical parsed facts with the existing stable JSON implementation.
 * @param value - Captured configuration or code file facts.
 * @returns The lowercase branded SHA-256.
 */
export function episodeFactsHash(value: unknown): Sha256 { return brandString<Sha256>(stableSha256(value)) }

type AnyEpisodeDescriptor = EpisodeRenderDescriptor | EpisodeRenderDescriptorV2 | EpisodeRenderDescriptorV3 | EpisodeRenderDescriptorV4

/** Bind private font copies to the original captured files and their relative names.
 * @param descriptor - Parsed capture and execution file records.
 * @returns Exact expected private font facts; the worker separately checks their bytes.
 */
export function episodePrivateFontFacts(descriptor: AnyEpisodeDescriptor) {
  const original = resolveSettings(descriptor.configuration.config).fontsDir
  const target = resolveSettings(descriptor.config).fontsDir
  if (!insideEpisodeRoot(descriptor.stageRoot, target)) throw new Error('Episode fonts escaped their private execution')
  const expected = descriptor.configuration.runtimeInputs.filter(file => file.owner === 'font').map((file) => {
    if (!insideEpisodeRoot(original, file.path)) throw new Error('Episode captured font escaped its original directory')
    return { path: join(target, relative(original, file.path)), sha256: file.sha256, bytes: file.bytes }
  })
  const staged = descriptor.stagedFiles.filter(file => insideEpisodeRoot(target, file.path))
  if (staged.length !== expected.length || expected.some((file) => {
    const copy = staged.find(row => row.path === file.path)
    return copy === undefined || copy.sha256 !== file.sha256 || copy.bytes !== file.bytes
  })) throw new Error('Episode private fonts differ from their original capture')
  return expected
}

function assertDescriptorCapture(parsed: AnyEpisodeDescriptor): void {
  const configuration = parsed.version === 4
    ? { configuration: parsed.configuration, clockInputs: parsed.clockInputs, sourceEvidence: parsed.sourceEvidence }
    : parsed.version === 3 ? { configuration: parsed.configuration, clockInputs: parsed.clockInputs } : parsed.configuration
  if (parsed.renderer.configurationSha256 !== parsed.identity.configurationSha256
    || episodeFactsHash(configuration) !== parsed.renderer.configurationSha256
    || episodeFactsHash(parsed.configuration.runtimeInputs.filter(file => file.owner === 'renderer')) !== parsed.renderer.codeSha256
    || parsed.originalProject !== parsed.configuration.projectDir) throw new Error('Episode descriptor capture identity mismatch')
  const stagedConfig = structuredClone(parsed.configuration.config)
  stagedConfig.fontsDir = resolveSettings(parsed.config).fontsDir
  if (episodeFactsHash(stagedConfig) !== episodeFactsHash(parsed.config)) {
    throw new Error('Episode descriptor changed captured renderer settings')
  }
  if (!insideEpisodeRoot(parsed.attemptRoot, parsed.stageRoot)
    || !insideEpisodeRoot(parsed.stageRoot, parsed.candidatePath) || !insideEpisodeRoot(parsed.stageRoot, parsed.candidateFactsPath)
    || parsed.stagedFiles.some(file => !insideEpisodeRoot(parsed.stageRoot, file.path))
    || [parsed.timelinePath, parsed.subtitlePath, parsed.mixProfilePath, parsed.bgmPath, parsed.endingAudio, parsed.endingEffect]
      .some(file => file !== undefined && !insideEpisodeRoot(parsed.stageRoot, file))) throw new Error('Episode descriptor escaped its private execution')
  episodePrivateFontFacts(parsed)
}

async function descriptorValue(path: string, expected: Sha256, maxBytes: number): Promise<unknown> {
  const bytes = await readEpisodeBytes(path, maxBytes)
  if (bytes === undefined || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Episode descriptor bytes changed')
  return JSON.parse(bytes.toString('utf8'))
}

/**
 * Decode exact bounded version-one descriptor bytes and reject retargeted identities/paths.
 * @param path - Private descriptor path supplied by the captured Host launcher.
 * @param expected - Exact byte SHA bound into the physical request.
 * @param maxBytes - Validated descriptor read budget.
 * @returns The immutable data after identity, config and private-path checks.
 */
export async function readEpisodeDescriptor(path: string, expected: Sha256, maxBytes: number): Promise<EpisodeRenderDescriptor> {
  const parsed = episodeDescriptorSchema.parse(await descriptorValue(path, expected, maxBytes))
  assertDescriptorCapture(parsed)
  return parsed
}

/**
 * Decode a prepared-audio descriptor and its optional private subtitle clock.
 * @param path - Captured descriptor location.
 * @param expected - SHA from the physical request.
 * @param maxBytes - Descriptor byte limit.
 * @returns Clock facts whose staged files are bound to their original bytes.
 */
export async function readEpisodeDescriptorV3(path: string, expected: Sha256, maxBytes: number): Promise<EpisodeRenderDescriptorV3> {
  const parsed = episodeDescriptorV3Schema.parse(await descriptorValue(path, expected, maxBytes))
  assertClockDescriptor(parsed)
  return parsed
}

function assertClockDescriptor(parsed: EpisodeRenderDescriptorV3 | EpisodeRenderDescriptorV4): void {
  assertDescriptorCapture(parsed)
  const { clockInputs: inputs, clockStage: stage } = parsed
  const ep = String(parsed.configuration.episode).padStart(2, '0')
  if ((inputs.clock === undefined ? stage.clockPath !== undefined
    : inputs.clock.path !== `${parsed.projectFiles.find(file => file.role === 'subtitle')?.originalPath}.clock.json`
      || stage.clockPath !== `${parsed.subtitlePath}.clock.json`)
    || inputs.manifest.path !== join(parsed.originalProject, 'editing', `${ep}-sources.json`)
    || (inputs.master === undefined ? stage.masterPath !== undefined || inputs.clock !== undefined
      : inputs.master.path !== join(parsed.originalProject, 'audio', `${ep}.wav`)
        || stage.masterPath !== join(parsed.stageRoot, 'audio', `${ep}.wav`))
    || stage.manifestPath !== join(parsed.stageRoot, 'editing', `${ep}-sources.json`)
    || inputs.shots.length !== parsed.stagedSources.length || stage.audio.length !== inputs.shots.length) {
    throw new Error('Episode subtitle clock paths do not match the captured episode')
  }
  const captured = (original: z.infer<typeof episodeFileSchema>, stagedPath: string): boolean =>
    insideEpisodeRoot(parsed.originalProject, original.path) && insideEpisodeRoot(parsed.stageRoot, stagedPath)
    && parsed.stagedFiles.some(file => file.path === stagedPath && file.sha256 === original.sha256 && file.bytes === original.bytes)
  if ((inputs.clock !== undefined && (stage.clockPath === undefined || !captured(inputs.clock, stage.clockPath)))
    || !captured(inputs.manifest, stage.manifestPath)
    || (inputs.master !== undefined && (stage.masterPath === undefined || !captured(inputs.master, stage.masterPath)))
    || inputs.shots.some((shot, index) => {
      const staged = parsed.stagedSources[index], audio = stage.audio[index]
      return shot.shot !== index + 1 || staged?.shot !== shot.shot || audio?.shot !== shot.shot
        || audio.originalPath !== shot.audio.path || !insideEpisodeRoot(parsed.originalProject, shot.video.path)
        || shot.video.sha256 !== staged.sha256 || shot.video.bytes !== staged.bytes || !captured(shot.audio, audio.stagedPath)
    })) throw new Error('Episode subtitle clock differs from captured stage files')
}

/**
 * Decode bounded version-two facts without authenticating the claimed Session or permitting execution.
 * @param path - Private descriptor path supplied by the captured Host launcher.
 * @param expected - Exact byte SHA obtained from the current physical request.
 * @param maxBytes - Validated descriptor read budget.
 * @returns Structurally consistent claims; callers must independently authenticate and revalidate them.
 */
export async function readEpisodeDescriptorV2(path: string, expected: Sha256, maxBytes: number): Promise<EpisodeRenderDescriptorV2> {
  const parsed = episodeDescriptorV2Schema.parse(await descriptorValue(path, expected, maxBytes))
  assertSourceDescriptor(parsed)
  return parsed
}

function assertSourceDescriptor(parsed: EpisodeRenderDescriptorV2 | EpisodeRenderDescriptorV4): void {
  assertDescriptorCapture(parsed)
  const claim = parsed.sourceClaim
  if (episodeFactsHash(claim.identity) !== episodeFactsHash(parsed.identity) || claim.execution !== parsed.execution) {
    throw new Error('Episode source claim belongs to another execution')
  }
  if (parsed.attemptRoot !== join(parsed.originalProject, '.muse', 'episode-delivery', parsed.identity.attempt)
    || parsed.stageRoot !== join(parsed.attemptRoot, parsed.execution, 'stage')) {
    throw new Error('Episode source claim has a retargeted execution root')
  }
  if ([claim.workspaceRoot, parsed.originalProject, parsed.attemptRoot, parsed.stageRoot].some(value => resolve(value) !== value)
    || claim.files.some(file =>
      resolve(file.originalPath) !== file.originalPath || resolve(file.stagedPath) !== file.stagedPath
      || file.aliases?.some(alias => resolve(alias) !== alias || alias === parsed.stageRoot
        || insideEpisodeRoot(parsed.stageRoot, alias)) === true
      || file.originalPath === parsed.stageRoot || insideEpisodeRoot(parsed.stageRoot, file.originalPath)
      || !insideEpisodeRoot(parsed.stageRoot, file.stagedPath))) throw new Error('Episode source claim has an invalid path')
  if (new Set(claim.files.map(file => file.originalPath)).size !== claim.files.length
    || new Set(claim.files.map(file => file.stagedPath)).size !== claim.files.length
    || new Set(parsed.stagedFiles.map(file => file.path)).size !== parsed.stagedFiles.length
    || claim.files.some(file => new Set(file.roles).size !== file.roles.length)) throw new Error('Episode source claim has ambiguous mappings')
  const spellings = new Map<string, string>()
  for (const file of claim.files) for (const spelling of [file.originalPath, ...file.aliases ?? []]) {
    const previous = spellings.get(spelling)
    if (previous !== undefined && previous !== file.originalPath) throw new Error('Episode source claim has ambiguous aliases')
    spellings.set(spelling, file.originalPath)
  }
  if (new Set(claim.directories.map(directory => directory.originalPath)).size !== claim.directories.length
    || claim.directories.some(directory => resolve(directory.originalPath) !== directory.originalPath
      || new Set(directory.entries).size !== directory.entries.length
      || directory.entries.some(name => name === '.' || name === '..' || name.includes('/') || name.includes('\\')))) {
    throw new Error('Episode source claim has invalid directory snapshots')
  }
  const reviewDirectory = join(parsed.originalProject, 'reviews')
  const reviews = claim.directories.find(directory => directory.originalPath === reviewDirectory)
  const reviewPattern = new RegExp(`^ep${String(parsed.configuration.episode).padStart(2, '0')}-p\\d{2,}\\.json$`, 'u')
  if (reviews === undefined || reviews.entries.filter(name => reviewPattern.test(name)).some(name =>
    !claim.files.some(file => file.originalPath === join(reviewDirectory, name) && file.roles.includes('review-record')))
    || claim.files.some(file => file.roles.includes('review-record')
      && (!file.originalPath.startsWith(reviewDirectory + sep)
        || !reviews.entries.includes(relative(reviewDirectory, file.originalPath))))) {
    throw new Error('Episode source claim has incomplete review directory facts')
  }
  const roles = new Set(claim.files.flatMap(file => file.roles))
  for (const role of ['source-manifest', 'selected-video', 'source-audio', 'review-record',
    'package-record', 'ocr', 'inspection'] as const) {
    if (!roles.has(role)) throw new Error('Episode source claim is incomplete')
  }
  if ((parsed.version === 2 || parsed.clockInputs.master !== undefined) && !roles.has('master-audio')) {
    throw new Error('Episode source claim is missing the captured master audio')
  }
  if (roles.has('subtitle-clock') !== (claim.subtitleClock === 'present')) throw new Error('Episode subtitle clock claim is inconsistent')
  if (claim.files.some(file => !parsed.stagedFiles.some(staged => staged.path === file.stagedPath
    && staged.sha256 === file.sha256 && staged.bytes === file.bytes))) throw new Error('Episode source claim differs from staged files')
  const bindingKeys = claim.bindings.map(binding => JSON.stringify(binding))
  if (new Set(bindingKeys).size !== bindingKeys.length || claim.bindings.some((binding) => {
    const media = claim.files.find(file => file.originalPath === binding.mediaOriginalPath)
    const ocr = claim.files.find(file => file.originalPath === binding.ocrOriginalPath)
    const inspection = claim.files.find(file => file.originalPath === binding.inspectionOriginalPath)
    return media === undefined || !(media.roles.includes('selected-video') || media.roles.includes('source-audio'))
      || ocr === undefined || !ocr.roles.includes('ocr') || inspection === undefined || !inspection.roles.includes('inspection')
  })) throw new Error('Episode source claim has invalid review bindings')
  const videos = claim.files.filter(file => file.roles.includes('selected-video'))
  if (videos.length !== parsed.stagedSources.length
    || new Set(parsed.stagedSources.map(source => source.path)).size !== parsed.stagedSources.length
    || videos.some(file => !claim.bindings.some(binding => binding.mediaOriginalPath === file.originalPath))
    || parsed.stagedSources.some(source => !videos.some(file =>
      file.stagedPath === source.path && file.sha256 === source.sha256 && file.bytes === source.bytes))) {
    throw new Error('Episode source claim differs from selected videos')
  }
}

/** Decode the clock and reviewed-source successor without granting Host authority.
 * @param path - Private descriptor path supplied by the captured Host launcher.
 * @param expected - Exact descriptor byte hash from its physical request.
 * @param maxBytes - Descriptor byte limit.
 * @returns Structurally consistent clock and source claims.
 */
export async function readEpisodeDescriptorV4(path: string, expected: Sha256, maxBytes: number): Promise<EpisodeRenderDescriptorV4> {
  const parsed = episodeDescriptorV4Schema.parse(await descriptorValue(path, expected, maxBytes))
  assertClockDescriptor(parsed)
  assertSourceDescriptor(parsed)
  const { sourceEvidence: evidence, sourceClaim: claim } = parsed
  if (new Set(evidence.files.map(file => file.path)).size !== evidence.files.length
    || new Set(evidence.bindings.map(binding => episodeFactsHash(binding))).size !== evidence.bindings.length
    || evidence.selectedPaths.length !== parsed.stagedSources.length
    || new Set(evidence.selectedPaths).size !== evidence.selectedPaths.length
    || evidence.selectedPaths.some((path, index) => !claim.files.some(file => file.originalPath === path
      && file.roles.includes('selected-video') && file.stagedPath === parsed.stagedSources[index]?.path))
    || new Set(evidence.sessions.map(session => session.sessionId)).size !== evidence.sessions.length
    || evidence.sessions.some(session => session.workspacePath !== claim.workspaceRoot || session.workspaceId !== claim.workspaceId)
    || !evidence.sessions.some(session => session.sessionId === claim.sessionId)
    || evidence.bindings.some(binding => !evidence.sessions.some(session => session.sessionId === binding.sessionId))
    || episodeFactsHash(evidence.directories) !== episodeFactsHash(claim.directories)
    || evidence.files.length !== claim.files.length || evidence.files.some(file => !claim.files.some(row =>
    row.originalPath === file.path && row.sha256 === file.sha256 && row.bytes === file.bytes))
    || evidence.bindings.length !== claim.bindings.length || evidence.bindings.some(binding => !claim.bindings.some(row =>
    row.mediaOriginalPath === binding.mediaPath && row.ocrOriginalPath === binding.ocrPath
      && row.inspectionOriginalPath === binding.inspectionPath && row.reviewId === binding.reviewId
      && claim.files.some(file => file.originalPath === binding.mediaPath && file.sha256 === binding.mediaSha256)
      && claim.files.some(file => file.originalPath === binding.ocrPath && file.sha256 === binding.ocrSha256)
      && claim.files.some(file => file.originalPath === binding.inspectionPath && file.sha256 === binding.inspectionSha256)))) {
    throw new Error('Episode source evidence differs from the captured claim')
  }
  return parsed
}
