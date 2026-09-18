/**
 * Storyboard reads and the two exact snapshot transformations.
 *
 * Both transformations work on a snapshot the provider itself returned, so every
 * field the provider owns survives the round trip. That is why this plugin never
 * asks a caller to compose a full storyboard body: reading the current one and
 * changing exactly one field is both safer and smaller.
 *
 * `withGenerationEnabled` is the paid path. It refuses to run unless the saved
 * configuration already matches the requested package duration, because the
 * provider derives its own video length from `modelConfig.duration` and a
 * mismatch would silently generate a video of the wrong length.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(): never { throw new JubianError('CONTRACT_CHANGED') }

/** One storyboard snapshot as this plugin exposes it. */
export interface StoryboardView {
  storyboard_id: number
  script_id: number
  name: string | null
  is_generate: 0 | 1
  content_duration_ms: number | null
  material_keys: string[]
  model_config: Record<string, unknown>
  snapshot: Record<string, unknown>
}

function idOf(value: unknown): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid()
  return candidate
}

function configOf(source: Record<string, unknown>): Record<string, unknown> {
  const raw = source.modelConfig
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) as unknown } catch { invalid() }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid()
  const config = parsed as Record<string, unknown>
  if (config.ratio !== '9:16' || config.resolution !== '720p' || config.genNum !== 1
    || !Number.isSafeInteger(config.duration)) invalid()
  return config
}

/**
 * Read one storyboard snapshot.
 * @param data - Envelope `data` from `/aigc/storyboard/{storyboardId}`.
 * @param expectedStoryboardId - When given, the snapshot must be that storyboard.
 */
export function readStoryboard(data: unknown, expectedStoryboardId?: number): StoryboardView {
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid()
  const snapshot = structuredClone(data) as Record<string, unknown>
  const storyboard_id = idOf(snapshot.id), script_id = idOf(snapshot.scriptId)
  if (expectedStoryboardId !== undefined && storyboard_id !== expectedStoryboardId) invalid()
  const is_generate = snapshot.isGenerate
  if (is_generate !== 0 && is_generate !== 1) invalid()
  const config = configOf(snapshot)
  const materials = Array.isArray(snapshot.storyboardMaterialList) ? snapshot.storyboardMaterialList : []
  return { storyboard_id, script_id, name: typeof snapshot.storyboardName === 'string' ? snapshot.storyboardName : null,
    is_generate, content_duration_ms: (config.duration as number) * 1000 - 1000,
    material_keys: materials.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid()
      const key = (row as Record<string, unknown>).materialKey
      if (typeof key !== 'string' || !key) invalid()
      return key
    }), model_config: config, snapshot }
}

/**
 * The paid transformation: hand the provider its own snapshot with generation enabled.
 * @param data - Envelope `data` from `/aigc/storyboard/{storyboardId}`, read in the same call.
 * @param contentDurationMs - The package duration to generate: a whole 4000..14000 millisecond value.
 * @returns A PUT body that differs from the snapshot only in `isGenerate`.
 */
export function withGenerationEnabled(data: unknown, contentDurationMs: number): Record<string, unknown> {
  if (!Number.isSafeInteger(contentDurationMs) || contentDurationMs < 4000 || contentDurationMs > 14000
    || contentDurationMs % 1000 !== 0) invalid()
  const view = readStoryboard(data)
  if (view.is_generate !== 0) invalid()
  if (view.model_config.duration !== contentDurationMs / 1000 + 1) invalid()
  return { ...view.snapshot, isGenerate: 1 }
}

/**
 * The free transformation: hand the provider its own snapshot with generation disabled.
 * @param data - Envelope `data` from `/aigc/storyboard/{storyboardId}`.
 * @returns A PUT body that differs from the snapshot only in `isGenerate`.
 */
export function withGenerationDisabled(data: unknown): Record<string, unknown> {
  return { ...readStoryboard(data).snapshot, isGenerate: 0 }
}
