/** Strict data-only descriptor consumed by the standalone episode worker. */
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import { Config as RendererConfig, resolveSettings } from '@deepseek-ai/dsh-tool-episode-render'
import { attemptIdentitySchema, episodeHashSchema, readEpisodeBytes } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import type { EpisodeExecutionId, EpisodeRendererGeneration, Sha256 } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'

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

/** Bind private font copies to the original captured files and their relative names.
 * @param descriptor - Parsed capture and execution file records.
 * @returns Exact expected private font facts; the worker separately checks their bytes.
 */
export function episodePrivateFontFacts(descriptor: EpisodeRenderDescriptor) {
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

/**
 * Decode exact bounded regular descriptor bytes and reject retargeted identities/paths.
 * @param path - Private descriptor path supplied by the captured Host launcher.
 * @param expected - Exact byte SHA bound into the physical request.
 * @param maxBytes - Validated descriptor read budget.
 * @returns The immutable data after identity, config and private-path checks.
 */
export async function readEpisodeDescriptor(path: string, expected: Sha256, maxBytes: number): Promise<EpisodeRenderDescriptor> {
  const bytes = await readEpisodeBytes(path, maxBytes)
  if (bytes === undefined || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Episode descriptor bytes changed')
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  const parsed = episodeDescriptorSchema.parse(value)
  if (parsed.renderer.configurationSha256 !== parsed.identity.configurationSha256
    || episodeFactsHash(parsed.configuration) !== parsed.renderer.configurationSha256
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
  return parsed
}
