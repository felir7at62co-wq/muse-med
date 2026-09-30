/** Authoritative project settings, revision previews and a derived readable project bible. */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type SettingsForms from '@deepseek-ai/dsh-settings'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ProjectBudget } from '@deepseek-ai/dsh-jubian/types'
import { DRAMA_SETTINGS_NAMESPACE, type DramaSettings } from './settings.ts'

type JsonObject = { [key: string]: JsonValue }
type ProjectDefaults = JsonObject & { initial_budget_cents: number }

/** Live budget data owned by the same authorization reader as Jubian paid calls. */
export interface ProjectBudgetReader {
  /** @param scriptId - Bound remote project ID. @returns Effective authorization and actual ledger totals. */
  read(scriptId: number): Promise<ProjectBudget>
}

/** Changes accepted by the project tool; omitted fields preserve their current value. */
export const PROJECT_BIBLE_CHANGES = {
  title: { type: 'string', description: 'Project title.' },
  style: { type: 'string', description: 'Confirmed visual style and creative guidance.' },
  aspect_ratio: { type: 'string', description: 'Confirmed generation aspect ratio, checked against the live catalogue.' },
  jubian_script_id: { type: 'integer', description: 'Actual remote project ID. An existing binding cannot be replaced.' },
  video: { type: 'object', additionalProperties: false, description: 'Exact catalogue selection; model, platform and resolution are required together.', properties: {
    model_id: { type: 'string', required: true },
    platform_id: { type: 'string', required: true, description: 'Exact catalogue platformId value.' },
    resolution: { type: 'string', required: true, description: 'Generation resolution, separate from delivery pixels.' },
    generation_type: { type: 'integer', description: 'Optional actual catalogue genType.' },
  } },
  delivery: { type: 'object', additionalProperties: false, description: 'Delivery target; omitted numeric fields inherit the current project or Settings.', properties: {
    width: { type: 'integer' }, height: { type: 'integer' }, fps: { type: 'integer' },
    min_bitrate_mbps: { type: 'number' }, max_effective_chars_per_shot: { type: 'integer' },
  } },
  episode_plan: { type: 'object', additionalProperties: false, description: 'Flexible outline and episode length; fixed counts are optional.', properties: {
    mode: { type: 'string', enum: ['flexible', 'fixed'] }, outline: { type: 'string' },
    episode_count: { type: 'integer' }, target_seconds: { type: 'number' },
  } },
  package_bindings: { type: 'array', description: 'Append stable package IDs mapped to remote storyboards. Keep the same package ID through content edits.', items: {
    type: 'object', additionalProperties: false, properties: {
      package_id: { type: 'string', required: true }, storyboard_id: { type: 'integer', required: true },
      episode_id: { type: 'integer' },
    },
  } },
  characters: { type: 'array', description: 'Stable character identities and approved voice guidance. Provider reference-audio support must be checked separately.', items: {
    type: 'object', additionalProperties: false, properties: {
      character_id: { type: 'string', required: true }, name: { type: 'string' },
      aliases: { type: 'array', items: { type: 'string' } }, asset_id: { type: 'integer' },
      voice_profile: { type: 'object', additionalProperties: false, properties: {
        speaker_id: { type: 'string' }, description: { type: 'string', required: true,
          description: 'Approved gender/age, timbre, speaking style and accent to reuse in each package.' },
        reference_audio: { type: 'string', description: 'Optional user-approved reference path or remote ID; records intent without claiming provider support.' },
      } },
    },
  } },
  completed_tasks: { type: 'array', description: 'Append completed task references. Existing records are preserved.', items: {
    type: 'object', additionalProperties: false, properties: {
      task_id: { type: 'string', required: true }, kind: { type: 'string', required: true },
      package_id: { type: 'string' }, result_ref: { type: 'string' },
    },
  } },
} as const

/** One logged project-tool result, including the revision needed for its next update. */
export type ProjectBibleResult = JsonObject & {
  status: string
  expected_revision: string
  preview_fingerprint: string
  config: JsonObject
  proposed: JsonObject
  affected_stages: string[]
  /** Current default for projects without an explicit authorization. */
  current_settings_budget_cents: number
}

/** A filesystem failure code, without relying on platform-specific error classes. */
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

/** Refuse symbolic links and non-file output paths, including a held lock. */
async function plainFile(path: string): Promise<void> {
  let entry
  try { entry = await lstat(path) } catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Project output must be a regular file: ${path}`)
}

/** Existing real directory with no symbolic-link or junction ancestors. */
async function projectRoot(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error('Project directory must be absolute.')
  const root = resolve(directory)
  let current = parse(root).root
  for (const component of relative(current, root).split(sep).filter(Boolean)) {
    current = join(current, component)
    const entry = await lstat(current)
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Project path must be a real directory: ${current}`)
  }
  if (!(await lstat(root)).isDirectory()) throw new Error('Project path must be a directory.')
  return root
}

/** JSON object from a durable file or model/tool input. */
function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`)
  return value as JsonObject
}

/** Positive safe integer used for dimensions and provider identifiers. */
function positive(value: JsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`)
  return value
}

/** Nonempty caller-visible text. */
function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty text.`)
  return value
}

/** Printable JSON value with a label for an omitted optional field. */
function display(value: JsonValue | undefined, fallback = ''): string {
  if (value === undefined) return fallback
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Current defaults are resolved once per read or preview, without writing Settings. */
function defaults(settings: SettingsForms): ProjectDefaults {
  const row = settings.describe().find(candidate => candidate.ns === DRAMA_SETTINGS_NAMESPACE)
  if (!row) throw new Error('Drama settings are unavailable.')
  const values = row.value as DramaSettings
  return { initial_budget_cents: values.seriesBudgetCents, delivery: {
    width: values.deliverySpec.width, height: values.deliverySpec.height,
    fps: values.deliverySpec.fps, min_bitrate_mbps: values.deliverySpec.minBitrateMbps,
  } }
}

/** Revision covers exact file bytes, including legacy fields and external edits. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Read the sole authoritative file and validate its owned fields. */
async function state(root: string): Promise<{ config: JsonObject; revision: string }> {
  const path = join(root, 'project_config.json')
  await plainFile(path)
  let contents: string
  try { contents = await readFile(path, 'utf8') } catch (error) {
    if (hasCode(error, 'ENOENT')) return { config: {}, revision: 'missing' }
    throw error
  }
  const value: unknown = JSON.parse(contents.replace(/^\uFEFF/, ''))
  const config = object(value, 'project_config.json')
  if (config.jubian_script_id !== undefined) positive(config.jubian_script_id, 'jubian_script_id')
  if (config.project_bible !== undefined) validateBible(object(config.project_bible, 'project_bible'))
  return { config, revision: digest(contents) }
}

/** Validate owned numeric, selector and record fields at the durable/model JSON boundary. */
function validateBible(bible: JsonObject): void {
  if (bible.schema_version !== 1) throw new Error('Unsupported project_bible.schema_version; expected 1.')
  positive(bible.revision, 'project_bible.revision')
  for (const key of ['title', 'style', 'aspect_ratio']) if (bible[key] !== undefined) text(bible[key], key)
  if (typeof bible.initial_budget_cents !== 'number' || !Number.isSafeInteger(bible.initial_budget_cents) || bible.initial_budget_cents < 0) {
    throw new Error('initial_budget_cents must be nonnegative safe integer CNY cents.')
  }
  const delivery = object(bible.delivery, 'delivery')
  for (const key of ['width', 'height', 'fps', 'max_effective_chars_per_shot']) {
    if (delivery[key] !== undefined) positive(delivery[key], `delivery.${key}`)
  }
  for (const key of ['width', 'height', 'fps']) positive(delivery[key], `delivery.${key}`)
  if (Number(delivery.fps) > 240) throw new Error('delivery.fps must not exceed 240.')
  if (typeof delivery.min_bitrate_mbps !== 'number' || !Number.isFinite(delivery.min_bitrate_mbps) || delivery.min_bitrate_mbps <= 0) {
    throw new Error('delivery.min_bitrate_mbps must be positive.')
  }
  if (bible.video !== undefined) {
    const video = object(bible.video, 'video')
    text(video.model_id, 'video.model_id')
    text(video.platform_id, 'video.platform_id')
    text(video.resolution, 'video.resolution')
    if (video.generation_type !== undefined) positive(video.generation_type, 'video.generation_type')
  }
  if (bible.episode_plan !== undefined) {
    const plan = object(bible.episode_plan, 'episode_plan')
    if (plan.mode !== 'flexible' && plan.mode !== 'fixed') throw new Error('episode_plan.mode must be flexible or fixed.')
    if (plan.outline !== undefined) text(plan.outline, 'episode_plan.outline')
    if (plan.episode_count !== undefined) positive(plan.episode_count, 'episode_plan.episode_count')
    if (plan.target_seconds !== undefined && (typeof plan.target_seconds !== 'number' || !Number.isFinite(plan.target_seconds) || plan.target_seconds <= 0)) {
      throw new Error('episode_plan.target_seconds must be positive.')
    }
  }
  const packages = records(bible.package_bindings, 'package_bindings')
  const ids = new Set<string>(), storyboards = new Set<number>()
  for (const row of packages) {
    const id = text(row.package_id, 'package_id'), storyboard = positive(row.storyboard_id, 'storyboard_id')
    if (ids.has(id) || storyboards.has(storyboard)) throw new Error('package_bindings must map unique package and storyboard IDs.')
    ids.add(id); storyboards.add(storyboard)
    if (row.episode_id !== undefined) positive(row.episode_id, 'episode_id')
  }
  const identities = new Set<string>(), names = new Map<string, string>()
  for (const row of records(bible.characters, 'characters')) {
    const id = text(row.character_id, 'character_id')
    if (identities.has(id)) throw new Error('characters must contain unique character IDs.')
    identities.add(id)
    const name = text(row.name, 'characters.name')
    if (row.asset_id !== undefined) positive(row.asset_id, 'characters.asset_id')
    if (row.aliases !== undefined && (!Array.isArray(row.aliases) || !row.aliases.every(alias => typeof alias === 'string' && alias.trim()))) {
      throw new Error('characters.aliases must be nonempty text entries.')
    }
    for (const alias of [name, ...Array.isArray(row.aliases) ? row.aliases : []]) {
      const label = text(alias, 'character alias')
      if (names.has(label) && names.get(label) !== id) throw new Error(`Character name or alias is ambiguous: ${label}`)
      names.set(label, id)
    }
    if (row.voice_profile !== undefined) {
      const voice = object(row.voice_profile, 'voice_profile')
      text(voice.description, 'voice_profile.description')
      for (const key of ['speaker_id', 'reference_audio']) if (voice[key] !== undefined) text(voice[key], `voice_profile.${key}`)
    }
  }
  const tasks = new Set<string>()
  for (const row of records(bible.completed_tasks, 'completed_tasks')) {
    const id = text(row.task_id, 'task_id')
    if (tasks.has(id)) throw new Error('completed_tasks must contain unique task IDs.')
    tasks.add(id)
    text(row.kind, 'completed_tasks.kind')
    for (const key of ['package_id', 'result_ref']) if (row[key] !== undefined) text(row[key], key)
  }
  for (const row of records(bible.history, 'history')) {
    positive(row.revision, 'history.revision')
    text(row.reason, 'history.reason')
    for (const key of ['changed_fields', 'affected_stages']) {
      if (!Array.isArray(row[key]) || !row[key].every(item => typeof item === 'string')) throw new Error(`history.${key} must be a text array.`)
    }
  }
}

/** Lists of owned records in model input and durable data. */
function records(value: JsonValue | undefined, label: string): JsonObject[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  return value.map(row => object(row, label))
}

/** Append owned immutable records while preserving earlier versions and identities. */
function append(previous: JsonValue | undefined, added: JsonValue, key: string, label: string): JsonObject[] {
  const rows = records(previous, label)
  for (const row of records(added, label)) {
    const existing = rows.find(candidate => candidate[key] === row[key])
    if (existing && JSON.stringify(existing) !== JSON.stringify(row)) {
      throw new Error(`${label} ${display(row[key])} is already bound; preserve its original record.`)
    }
    if (!existing) rows.push(row)
  }
  return rows
}

/** Downstream work made stale by a changed creative or delivery requirement. */
function affected(keys: string[]): string[] {
  const stages = new Set<string>()
  for (const key of keys) {
    if (['style', 'aspect_ratio', 'characters'].includes(key)) for (const stage of ['asset_prompts', 'shots_and_matches', 'video_tasks', 'draft', 'export']) stages.add(stage)
    if (key === 'video') for (const stage of ['video_tasks', 'draft', 'export']) stages.add(stage)
    if (key === 'episode_plan') for (const stage of ['episodes', 'shots_and_matches', 'video_tasks', 'draft', 'export']) stages.add(stage)
    if (key === 'delivery') for (const stage of ['shots_and_matches', 'draft', 'export']) stages.add(stage)
  }
  return [...stages]
}

/** Build a candidate from current data, preserving unrelated legacy fields. */
function candidate(config: JsonObject, initial: JsonObject, changes: JsonObject,
  reason: string): { config: JsonObject; fields: string[]; stages: string[] } {
  if (!reason.trim()) throw new Error('A project update reason is required.')
  for (const key of Object.keys(changes)) if (!Object.hasOwn(PROJECT_BIBLE_CHANGES, key)) throw new Error(`Unsupported project change: ${key}`)
  const previous = config.project_bible === undefined ? {} : object(config.project_bible, 'project_bible')
  const bible: JsonObject = {
    ...initial, ...previous, schema_version: 1, revision: Number(previous.revision ?? 0) + 1,
  }
  const next: JsonObject = { ...config, project_bible: bible }
  if (changes.jubian_script_id !== undefined) {
    const id = positive(changes.jubian_script_id, 'jubian_script_id')
    if (config.jubian_script_id !== undefined && config.jubian_script_id !== id) throw new Error('Project is already bound to another jubian_script_id.')
    next.jubian_script_id = id
  }
  const legacyDelivery = config.delivery === undefined ? {} : object(config.delivery, 'delivery')
  bible.delivery = { ...object(initial.delivery, 'delivery'), ...legacyDelivery,
    ...(previous.delivery === undefined ? {} : object(previous.delivery, 'delivery')) }
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'jubian_script_id') continue
    if (key === 'delivery' || key === 'episode_plan') bible[key] = {
      ...(bible[key] === undefined ? {} : object(bible[key], key)), ...object(value, key),
    }
    else if (key === 'characters') {
      const characters = records(previous.characters, 'characters')
      for (const row of records(value, 'characters')) {
        const index = characters.findIndex(existing => existing.character_id === row.character_id)
        if (index < 0) characters.push(row)
        else {
          const existing = characters[index]
          if (!existing) throw new Error('Character record is unavailable.')
          characters[index] = { ...existing, ...row, ...(row.voice_profile === undefined ? {} : {
            voice_profile: { ...(existing.voice_profile === undefined ? {} : object(existing.voice_profile, 'voice_profile')),
              ...object(row.voice_profile, 'voice_profile') },
          }) }
        }
      }
      bible[key] = characters
    }
    else if (key === 'package_bindings') bible[key] = append(previous[key], value, 'package_id', key)
    else if (key === 'completed_tasks') bible[key] = append(previous[key], value, 'task_id', key)
    else bible[key] = value
  }
  if (changes.episode_plan !== undefined && object(changes.episode_plan, 'episode_plan').mode === undefined && previous.episode_plan === undefined) {
    object(bible.episode_plan, 'episode_plan').mode = 'flexible'
  }
  const fields = Object.keys(changes).filter(key => JSON.stringify(key === 'jubian_script_id' ? config[key] : previous[key])
    !== JSON.stringify(key === 'jubian_script_id' ? next[key] : bible[key]))
  const stages = affected(fields)
  bible.history = [...records(previous.history, 'history'), { revision: Number(bible.revision), reason, changed_fields: fields, affected_stages: stages }]
  const projectDelivery = object(bible.delivery, 'delivery')
  if (projectDelivery.max_effective_chars_per_shot !== undefined) next.delivery = {
    ...legacyDelivery, max_effective_chars_per_shot: projectDelivery.max_effective_chars_per_shot,
  }
  validateBible(bible)
  return { config: next, fields, stages }
}

/** Pure readable projection; the JSON file remains the only editable source. */
function markdown(config: JsonObject): string {
  const bible = object(config.project_bible, 'project_bible')
  const delivery = object(bible.delivery, 'delivery')
  const rows = [
    `# ${display(bible.title, '项目圣经')}`, '',
    `版本：${display(bible.revision)}；数据格式：${display(bible.schema_version)}`, '',
    '本文件由 project_config.json 自动生成。请通过 drama_project 预览并更新项目设定。', '',
    `远端项目：${display(config.jubian_script_id, '未绑定')}`, '',
    `风格：${display(bible.style, '待确认')}`, '',
    `生成比例：${display(bible.aspect_ratio, '待确认')}`, '',
    '## 生成与交付', '',
  ]
  if (bible.video !== undefined) {
    const video = object(bible.video, 'video')
    rows.push(`视频模型：${display(video.model_id)}；平台：${display(video.platform_id)}；生成分辨率：${display(video.resolution)}`, '')
  }
  rows.push(`成片：${display(delivery.width)} × ${display(delivery.height)}；${display(delivery.fps)} fps；最低 ${display(delivery.min_bitrate_mbps)} Mbps`, '',
    `预算初始记录：¥${(Number(bible.initial_budget_cents) / 100).toFixed(2)} CNY；当前项目总额度和已花/在途费用通过 drama_project read 或 jubian_budget read 从实际授权账本读取，初始记录不作为收费上限。`, '', '## 分集计划', '')
  if (bible.episode_plan !== undefined) rows.push('```json', JSON.stringify(bible.episode_plan, null, 2), '```', '')
  else rows.push('按剧情灵活确定集数、提纲和每集长度。', '')
  for (const [title, key] of [['角色与声音', 'characters'], ['稳定视频包绑定', 'package_bindings'], ['已完成任务', 'completed_tasks'], ['版本与影响记录', 'history']] as const) {
    rows.push(`## ${title}`, '', '```json', JSON.stringify(bible[key] ?? [], null, 2), '```', '')
  }
  return rows.join('\n')
}

/** Add live authorization data to the model-facing projection without duplicating its editable amount. */
async function withBudget(value: ProjectBibleResult, reader?: ProjectBudgetReader): Promise<ProjectBibleResult> {
  const selected = value.status === 'preview' ? value.proposed : value.config
  if (selected.jubian_script_id === undefined) return { ...value, budget: { status: 'unbound' } }
  if (!reader) return { ...value, budget: { status: 'unavailable' } }
  const budget = await reader.read(positive(selected.jubian_script_id, 'jubian_script_id'))
  const live = `当前总额度：${budget.limit_cents === null ? '未授权' : `¥${(budget.limit_cents / 100).toFixed(2)} ${budget.unit}`}；已花 ¥${(budget.settled_cents / 100).toFixed(2)}；在途 ¥${(budget.reserved_cents / 100).toFixed(2)}。\n`
  return { ...value, budget: { status: 'ready', ...budget },
    ...(selected.project_bible === undefined ? {} : { markdown: `${markdown(selected)}\n${live}` }) }
}

/** Shared bounded result fields; full JSON is returned only on an explicit read or preview. */
function result(root: string, snapshot: { config: JsonObject; revision: string }, initial: ProjectDefaults): ProjectBibleResult {
  return { status: snapshot.config.project_bible === undefined ? 'unconfigured' : 'ready',
    project_dir: root, config_path: join(root, 'project_config.json'), bible_path: join(root, 'project-bible.md'),
    expected_revision: snapshot.revision, preview_fingerprint: '', config: snapshot.config,
    proposed: {}, affected_stages: [], defaults: initial, current_settings_budget_cents: initial.initial_budget_cents }
}

/**
 * Read authoritative project settings and current Settings defaults without creating files.
 * @param settings - Provider owning the drama namespace.
 * @param directory - Existing absolute project directory with no link ancestors.
 * @param budget - Optional live reader shared with the actual Jubian authorization.
 * @returns Current config, file revision and defaults; missing bible returns unconfigured.
 */
export async function readProjectBible(settings: SettingsForms, directory: string,
  budget?: ProjectBudgetReader): Promise<ProjectBibleResult> {
  const root = await projectRoot(directory)
  return await withBudget(result(root, await state(root), defaults(settings)), budget)
}

/**
 * Preview a project update, its readable projection and downstream impact without writing.
 * Model support must be checked through the existing Jubian catalogue and preparation tools.
 * @param settings - Provider supplying first-project budget and delivery defaults.
 * @param directory - Existing absolute project directory.
 * @param changes - Confirmed fields to merge; optional mappings and completed tasks append.
 * @param reason - User-visible reason preserved in revision history.
 * @param budget - Optional live reader shared with the actual Jubian authorization.
 * @returns Candidate config, expected revision, preview fingerprint and affected stages.
 */
export async function previewProjectBible(settings: SettingsForms, directory: string,
  changes: JsonObject, reason: string, budget?: ProjectBudgetReader): Promise<ProjectBibleResult> {
  const root = await projectRoot(directory), snapshot = await state(root), initial = defaults(settings)
  const proposed = candidate(snapshot.config, initial, changes, reason)
  const fingerprint = digest(JSON.stringify({ root, revision: snapshot.revision, config: proposed.config }))
  return await withBudget({ ...result(root, snapshot, initial), status: 'preview', proposed: proposed.config,
    preview_fingerprint: fingerprint, changed_fields: proposed.fields, affected_stages: proposed.stages,
    markdown: markdown(proposed.config) }, budget)
}

/** Exclusive temporary file in the destination directory, replaced by one atomic rename. */
async function atomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try { await handle.writeFile(content, 'utf8') } finally { await handle.close() }
    await plainFile(path)
    await rename(temporary, path)
  } finally {
    try { await unlink(temporary) } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
  }
}

/**
 * Commit a reviewed update under an exclusive project writer lock and exact file revision.
 * JSON commits atomically before its derived Markdown; a Markdown failure reports the committed revision.
 * @param settings - Provider supplying current first-project defaults.
 * @param directory - Existing absolute project directory.
 * @param changes - Same changes used by the preview.
 * @param reason - Same reason used by the preview.
 * @param expectedRevision - Exact revision returned by read or preview; missing creates a new config.
 * @param previewFingerprint - Fingerprint of the unchanged reviewed preview.
 * @param signal - Optional caller cancellation; observed before the commit starts.
 * @param budget - Optional live reader shared with the actual Jubian authorization.
 * @returns Saved config and new revision, preserving completed records and prior versions.
 */
export async function updateProjectBible(settings: SettingsForms, directory: string, changes: JsonObject, reason: string,
  expectedRevision: string, previewFingerprint: string, signal?: AbortSignal, budget?: ProjectBudgetReader): Promise<ProjectBibleResult> {
  const root = await projectRoot(directory), lockPath = join(root, '.project-bible.lock')
  signal?.throwIfAborted()
  await plainFile(lockPath)
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) } catch (error) {
    if (hasCode(error, 'EEXIST')) throw new Error('Another project bible update holds .project-bible.lock; inspect that writer before removing an abandoned lock.')
    throw error
  }
  try {
    const preview = await previewProjectBible(settings, root, changes, reason)
    if (preview.expected_revision !== expectedRevision) throw new Error('Project file revision changed; read and preview again.')
    if (preview.preview_fingerprint !== previewFingerprint) throw new Error('Preview changed; preview the same changes and Settings again.')
    const configPath = join(root, 'project_config.json'), biblePath = join(root, 'project-bible.md')
    await plainFile(configPath)
    await plainFile(biblePath)
    signal?.throwIfAborted()
    const contents = `${JSON.stringify(preview.proposed, null, 2)}\n`
    await atomic(configPath, contents)
    try { await atomic(biblePath, markdown(preview.proposed)) } catch (error) {
      throw new Error(`Project JSON committed at revision ${digest(contents)}, but rendering project-bible.md failed. Read current config before retrying.`, { cause: error })
    }
    return await withBudget({ ...result(root, { config: preview.proposed, revision: digest(contents) }, defaults(settings)),
      status: 'ready', affected_stages: preview.affected_stages, changed_fields: preview.changed_fields ?? [] }, budget)
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}
