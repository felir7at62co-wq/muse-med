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
 * mismatch would silently generate a video of the wrong length. A storyboard with
 * no saved configuration at all refuses the same way rather than generating from a
 * substituted specification, and that refusal names the expected settings, the ones
 * the provider did not return, the payload it received and how to save them.
 */
import { JubianError, describeRejection } from '@deepseek-ai/dsh-jubian'
import { validateVideoDuration } from './native.ts'
import { readPayload } from './reading.ts'

function invalid(detail: string): never { throw new JubianError('CONTRACT_CHANGED', detail) }

/**
 * The `modelConfig` fields the paid path hands the provider unchanged, in the order a refusal names them.
 *
 * This reader substitutes the first three and never the last two: `duration` is the
 * length the provider derives its video from and `modelId` is the channel it buys
 * from, so a value for either would be this library's invention rather than a
 * default. {@link withGenerationEnabled} refuses a saved configuration missing any
 * of them, because the body it returns is the provider's own snapshot.
 */
const PAID_CONFIG_FIELDS = ['ratio', 'resolution', 'genNum', 'duration', 'modelId'] as const

/**
 * The `modelConfig` fields this reader substitutes when the provider returns none of them,
 * and the value it uses.
 *
 * The two labels and the generation count describe a saved choice or a request
 * specification rather than the storyboard's identity, and the values are the
 * legacy specification {@link withGenerationEnabled} accepts anyway. Every
 * substitution is reported in {@link StoryboardView.model_config_defaults}.
 */
const CONFIG_FALLBACKS: readonly (readonly [string, string | number])[] =
  [['ratio', '9:16'], ['resolution', '720p'], ['genNum', 1]]

/** One storyboard snapshot as this plugin exposes it. */
export interface StoryboardView {
  storyboard_id: number
  script_id: number
  name: string | null
  is_generate: 0 | 1
  content_duration_ms: number | null
  material_keys: string[]
  model_config: Record<string, unknown>
  /**
   * `modelConfig` fields the provider returned nothing for, with the value this read used instead.
   *
   * Empty when the storyboard carries a complete saved configuration. A non-empty
   * map means the settings in `model_config` are this reader's defaults and not the
   * provider's values.
   */
  model_config_defaults: Record<string, string | number>
  /**
   * One sentence per replaced value, for the caller and the model reading this result.
   *
   * `model_config_defaults` is the same fact as a map of wire field to substituted
   * value; these sentences state which value the substitution means, because a map
   * of keys a caller did not ask for reads as data rather than as a warning.
   */
  model_config_notes: string[]
  snapshot: Record<string, unknown>
}

function idOf(value: unknown, field: string): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) {
    invalid(`the storyboard ${field} is not a positive integer`)
  }
  return candidate
}

/**
 * Read a storyboard's saved `modelConfig`, substituting a default for what the provider did not return.
 *
 * A model setting is a saved user choice, so the provider returns no `modelConfig`
 * at all on a storyboard whose model was never chosen — a freshly created board or
 * a placeholder. Identity, name and material keys do not depend on those settings,
 * so the read continues and reports every substitution instead of refusing a
 * payload the workbench itself displays.
 *
 * A label the provider does return must still be usable: `null`, a blank string and
 * an absent key are its own spellings of "unset", and anything else that cannot be
 * read is a contract change that names the field it refused.
 *
 * `duration` is never defaulted. The view reports it as `content_duration_ms` and
 * the paid path compares it against the requested package, so a substituted value
 * would be an invented length rather than a default: its absence leaves
 * `content_duration_ms` null and refuses `withGenerationEnabled`. A malformed saved
 * duration is preserved and reported in notes so the same card can be repaired.
 * @param source - One raw storyboard snapshot.
 * @returns The saved configuration, every substituted field named as a map entry and a sentence.
 */
function configOf(source: Record<string, unknown>): {
  config: Record<string, unknown>
  defaults: Record<string, string | number>
  notes: string[]
} {
  const raw = source.modelConfig
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    // Blank text is the provider's third spelling of unset, beside `null` and an
    // absent key; only text it did send is parsed, and text that is not JSON is refused by name.
    if (!raw.trim()) parsed = {}
    else { try { parsed = JSON.parse(raw) } catch { invalid('modelConfig is not JSON') } }
  }
  if (parsed === undefined || parsed === null) parsed = {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) invalid('modelConfig is not a JSON object')
  const config = { ...(parsed as Record<string, unknown>) }
  const defaults: Record<string, string | number> = {}
  const notes: string[] = []
  for (const [field, fallback] of CONFIG_FALLBACKS) {
    const value = config[field]
    if (value === undefined || value === null) {
      config[field] = fallback
      defaults[field] = fallback
      notes.push(`服务端未返回 modelConfig.${field}，已按默认 ${String(fallback)} 处理`)
      continue
    }
    // A blank label is a value the provider did send, so it is read as one: this
    // reader substitutes for what is missing, never for what it cannot use.
    const usable = field === 'genNum' ? value === 1 : typeof value === 'string' && Boolean(value.trim())
    if (!usable) invalid(`modelConfig.${field} is not ${field === 'genNum' ? '1' : 'a nonempty label'}`)
  }
  const duration = config.duration
  if (duration !== undefined && duration !== null && !usableDuration(duration)) {
    notes.push('modelConfig.duration 不是可安全表示为毫秒的正整数秒；原值已保留。'
      + '请用 jubian_storyboard edit_preview → edit_apply 修复该卡的 duration 后再准备生成。')
  }
  return { config, defaults, notes }
}

/** Whether a saved duration can be used as whole milliseconds. */
function usableDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    && Number.isSafeInteger(value * 1000)
}

/**
 * Read the ordered materials however the provider serialized them.
 *
 * This list is optional: the provider spells an unset one as `null`, and a
 * storyboard that has not had its subjects chosen yet legitimately carries none.
 * It is serialized inline on some routes and as JSON text on others, so a list the
 * reader cannot parse is refused by name rather than reported as an empty one.
 * @param source - One raw storyboard snapshot.
 * @returns One entry per ordered material, or an empty list when the field is unset.
 */
function materialRowsOf(source: Record<string, unknown>): unknown[] {
  const raw = source.storyboardMaterialList
  if (raw === undefined || raw === null || raw === '') return []
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { invalid('storyboardMaterialList is not JSON') }
    if (Array.isArray(parsed)) return parsed
  }
  return invalid('storyboardMaterialList is not a list of materials')
}

/**
 * Read one storyboard snapshot.
 *
 * Only the identity, the generation flag and the material keys are required. A
 * storyboard whose model was never chosen reads through with a substituted
 * specification, reported in `model_config_defaults` and in `model_config_notes`,
 * and `content_duration_ms` stays null because no saved duration exists.
 *
 * Every other field the provider may hold as `null` — `episodeCount`, `scriptName`,
 * `remark`, `updateBy`, `updateTime`, `videoSubTaskList` — is carried through the
 * snapshot and read by nothing here, so a legal `null` is never a refusal reason.
 * Only a field this read exists to answer for is checked.
 * @param data - Envelope `data` from `/aigc/storyboard/{storyboardId}`.
 * @param expectedStoryboardId - When given, the snapshot must be that storyboard.
 * @returns The snapshot's identity, duration, material keys and every substituted setting.
 */
export function readStoryboard(data: unknown, expectedStoryboardId?: number): StoryboardView {
  return readPayload('readStoryboard', data, () => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('the payload is not a JSON object')
    const snapshot = structuredClone(data) as Record<string, unknown>
    const storyboard_id = idOf(snapshot.id, 'id'), script_id = idOf(snapshot.scriptId, 'scriptId')
    if (expectedStoryboardId !== undefined && storyboard_id !== expectedStoryboardId) {
      invalid(`the payload is storyboard ${storyboard_id}, not the requested ${expectedStoryboardId}`)
    }
    const is_generate = snapshot.isGenerate
    if (is_generate !== 0 && is_generate !== 1) invalid('isGenerate is neither 0 nor 1')
    const { config, defaults, notes } = configOf(snapshot)
    const materials = materialRowsOf(snapshot)
    return { storyboard_id, script_id, name: typeof snapshot.storyboardName === 'string' ? snapshot.storyboardName : null,
      is_generate,
      content_duration_ms: usableDuration(config.duration) ? config.duration * 1000 - 1000 : null,
      material_keys: materials.map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          invalid(`storyboardMaterialList[${index}] is not an object`)
        }
        const key = (row as Record<string, unknown>).materialKey
        if (typeof key !== 'string' || !key) {
          invalid(`storyboardMaterialList[${index}].materialKey is not a nonempty key`)
        }
        return key
      }), model_config: config, model_config_defaults: defaults, model_config_notes: notes, snapshot }
  })
}

/**
 * The paid transformation: hand the provider its own snapshot with generation enabled.
 *
 * `is_generate` is deliberately not a precondition. The provider stores 1 on every storyboard it holds,
 * including ones that never generated, so the field cannot tell a generated storyboard from an ungenerated
 * one. What the provider acts on is the `isGenerate` inside the body this function returns.
 *
 * The body is the provider's own snapshot, so the provider generates from the
 * `modelConfig` it saved and not from the values this reader substituted. The call
 * therefore refuses a saved configuration that is missing any field the provider
 * acts on, naming the field, the ones it expected, the payload it received and the
 * way to save them — rather than generating at a length or on a channel this
 * library invented. Read a storyboard with {@link readStoryboard} to see its
 * substituted view without paying.
 *
 * @param data - Envelope `data` from `/aigc/storyboard/{storyboardId}`, read in the same call.
 * @param contentDurationMs - The package duration to generate: a whole 4000..14000 millisecond value.
 * @returns A PUT body that differs from the snapshot only in `isGenerate`.
 * @throws {JubianError} `INVALID_ARGUMENT` naming the missing saved settings, or `CONTRACT_CHANGED`
 *   for a payload no reader can map.
 */
export function withGenerationEnabled(data: unknown, contentDurationMs: number): Record<string, unknown> {
  return readPayload('withGenerationEnabled', data, () => {
    if (!Number.isSafeInteger(contentDurationMs) || contentDurationMs < 4000 || contentDurationMs > 14000
      || contentDurationMs % 1000 !== 0) invalid('content_duration_ms must be a whole 4000..14000 millisecond value')
    const view = readStoryboard(data)
    const config = view.model_config
    // Only what the provider must have saved is required: a substituted label is this
    // reader's default and would never reach the provider, while a missing duration or
    // model would leave the provider choosing the length or the channel itself.
    const substituted = view.model_config_defaults
    const absent = PAID_CONFIG_FIELDS.filter(field => field === 'duration' || field === 'modelId'
      ? config[field] === undefined || config[field] === null
      : substituted[field] !== undefined)
    if (absent.length > 0) {
      throw new JubianError('INVALID_ARGUMENT',
        '该分镜没有完整的已保存模型设置，旧 generate 无法确定生成规格：期望 '
        + `${PAID_CONFIG_FIELDS.map(field => `modelConfig.${field}`).join('、')}；`
        + `服务端没有返回 ${absent.map(field => `modelConfig.${field}`).join('、')}。`
        + '修法：先用 jubian_model preview → apply 为该分镜保存模型通道与时长（等价于在工作台里为该分镜选定模型），再 generate。'
        + `收到的载荷：${describeRejection(data)}`)
    }
    if (config.ratio !== '9:16' || config.resolution !== '720p') {
      throw new JubianError('INVALID_ARGUMENT', '旧 generate 不支持该分镜规格；保留当前设置，改用 prepare_video → submit_video，不要为绕过此限制切换模型或分辨率。')
    }
    if (typeof config.modelId !== 'string') invalid('modelConfig.modelId is absent, so the saved model cannot be re-checked')
    validateVideoDuration(config.modelId, config.duration)
    if (config.duration !== contentDurationMs / 1000 + 1) {
      invalid(`the saved duration ${String(config.duration)} is not the requested package plus one second`)
    }
    return { ...view.snapshot, isGenerate: 1 }
  })
}

/**
 * The free transformation: hand the provider its own snapshot with generation disabled.
 * @param data - Envelope `data` from `/aigc/storyboard/{storyboardId}`.
 * @returns A PUT body that differs from the snapshot only in `isGenerate`.
 */
export function withGenerationDisabled(data: unknown): Record<string, unknown> {
  return readPayload('withGenerationDisabled', data, () => ({ ...readStoryboard(data).snapshot, isGenerate: 0 }))
}
