/** Frozen previews and free in-place edits of existing Jubian storyboard cards. */
import { join } from 'node:path'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { normalizedPrompt, resolveVideoModel, stableJson, stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import { atomicWriteJson, positiveInteger, validateProjectBinding } from './native.ts'
import type { ImageBatchOptions, MethodArgs } from './methods.ts'
import { bodyHash, need, requireKey, writeUnderLedger } from './write.ts'
import { markReselection } from './reselection.ts'
import { readPreparedJson } from './prepared-file.ts'

type Row = Record<string, unknown>
const MODEL_KEYS = ['modelId', 'platformId', 'ratio', 'resolution', 'genType', 'duration', 'genNum'] as const
const BOARD_FIELDS = { name: 'storyboardName', episode_id: 'episodeId', sort_order: 'sortOrder' } as const
const AUDIT_KEYS = ['updateTime', 'updateBy', 'createTime', 'createBy'] as const
interface Edit { storyboard_id: number; changes: Row }
interface Target {
  storyboard_id: number
  before_hash: string
  expected_hash: string
  request_hash: string
  before: Row
  after: Row
  selection_status: 'unchanged' | 'needs_reselect'
  prompt_keys: string[]
  selected_keys: unknown[]
}
interface Plan {
  version: 1
  operation: 'storyboard_edit'
  script_id: number
  edits: Edit[]
  targets: Target[]
  fingerprint: string
}
function invalid(detail: string): never { throw new JubianError('INVALID_ARGUMENT', detail) }
function fail(detail: string): never { throw new JubianError('CONTRACT_CHANGED', detail) }
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Expected a JSON object')
  return value as Row
}
function changesOf(value: unknown): Row {
  const changes = object(value)
  const allowed = [...MODEL_KEYS, 'prompt', ...Object.keys(BOARD_FIELDS)]
  if (!Object.keys(changes).length || Object.keys(changes).some(key => !allowed.includes(key))) {
    invalid('changes accepts only prompt/modelId/platformId/ratio/resolution/genType/duration/genNum/name/episode_id/sort_order')
  }
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'sort_order') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('sort_order must be a nonnegative integer')
    } else if (['genType', 'duration', 'genNum', 'episode_id'].includes(key)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(`${key} must be a positive integer`)
    } else if (typeof value !== 'string' || !value.trim()) invalid(`${key} must be nonempty text`)
  }
  return structuredClone(changes)
}
function editsOf(value: unknown, limits: ImageBatchOptions): Edit[] {
  if (!Array.isArray(value) || !value.length || value.length > limits.maxItems) {
    invalid(`edits must contain 1..${limits.maxItems} items`)
  }
  const edits = value.map((raw) => {
    const item = object(raw)
    if (Object.keys(item).some(key => key !== 'storyboard_id' && key !== 'changes')) invalid('Unknown edit item field')
    return { storyboard_id: positiveInteger(item.storyboard_id), changes: changesOf(item.changes) }
  }).sort((a, b) => a.storyboard_id - b.storyboard_id)
  if (new Set(edits.map(item => item.storyboard_id)).size !== edits.length) invalid('Duplicate storyboard_id')
  return edits
}
function configOf(board: Row): Row {
  const raw = board.modelConfig
  if (raw === null || raw === undefined || raw === '') return {}
  if (typeof raw !== 'string') return object(raw)
  try { return object(JSON.parse(raw)) }
  catch (error) { return fail(error instanceof JubianError ? error.message : 'Invalid modelConfig JSON') }
}
function materialsOf(board: Row): unknown[] {
  const raw = board.storyboardMaterialList
  if (raw === null || raw === undefined || raw === '') return []
  let rows: unknown = raw
  if (typeof raw === 'string') {
    try { rows = JSON.parse(raw) }
    catch (error) { return fail(error instanceof Error ? 'Invalid storyboardMaterialList JSON' : 'Unreadable materials') }
  }
  if (!Array.isArray(rows)) return fail('Invalid storyboardMaterialList')
  return rows
}
function snapshot(board: Row): Row {
  const { isGenerate: _generate, ...rest } = board
  return { ...rest, modelConfig: configOf(board), storyboardMaterialList: materialsOf(board) }
}
function comparable(board: Row): Row {
  const state = snapshot(board)
  state.storyboardMaterialList = materialsOf(board).map(row => Object.fromEntries(Object.entries(object(row))
    .filter(([field]) => field !== 'id' && !(AUDIT_KEYS as readonly string[]).includes(field))))
  return Object.fromEntries(Object.entries(state).filter(([key]) => !(AUDIT_KEYS as readonly string[]).includes(key)))
}
function view(board: Row): Row {
  const config = configOf(board)
  const result: Row = {}
  for (const [key, field] of Object.entries(BOARD_FIELDS)) result[key] = board[field] ?? null
  for (const key of ['prompt', ...MODEL_KEYS, 'standardId', 'modelGenerationTypeId', 'videoStandardId']) {
    result[key] = config[key] ?? null
  }
  return result
}
function markers(value: unknown): { name: string; key: string }[] {
  if (typeof value !== 'string') return []
  const seen = new Set<string>()
  return [...normalizedPrompt(value).matchAll(/@\[([^\]]+)\]\(([^()\s]+)\)/g)]
    .map(match => ({ name: match[1] ?? '', key: match[2] ?? '' }))
    .filter(marker => !seen.has(marker.key) && Boolean(seen.add(marker.key)))
}
async function readBoard(client: JubianClient, scriptId: number, storyboardId: number): Promise<Row> {
  const board = object((await client.request({ method: 'GET', path: `/aigc/storyboard/${storyboardId}` })).data)
  if (positiveInteger(board.id) !== storyboardId || positiveInteger(board.scriptId) !== scriptId) fail('Storyboard identity mismatch')
  return board
}
async function episodeIds(client: JubianClient, scriptId: number): Promise<Set<number>> {
  const ids = new Set<number>()
  let total: number | undefined
  for (let page = 1; page <= 40; page++) {
    const data = (await client.request({ method: 'GET',
      path: `/aigc/episode/list?scriptId=${scriptId}&pageNum=${page}&pageSize=100` })).data
    const envelope = Array.isArray(data) ? { rows: data } : object(data)
    const rows = envelope.rows ?? envelope.list
    if (!Array.isArray(rows)) fail('Unreadable episode catalogue')
    if (envelope.total !== undefined) {
      const count = envelope.total
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0
        || (total !== undefined && count !== total)) fail('Episode catalogue total drift')
      total = count
    }
    for (const raw of rows) {
      const row = object(raw); const id = positiveInteger(row.id)
      if (ids.has(id) || (row.scriptId !== undefined && positiveInteger(row.scriptId) !== scriptId)) fail('Episode catalogue identity mismatch')
      ids.add(id)
    }
    if (total !== undefined && ids.size > total) fail('Episode catalogue total mismatch')
    if (total === ids.size || (total === undefined && rows.length < 100)) return ids
    if (rows.length < 100) fail('Incomplete episode catalogue')
  }
  return fail('Episode catalogue exceeds 40 pages')
}
function patched(board: Row, changes: Row, catalogue?: unknown): Row {
  const config = { ...configOf(board) }
  for (const key of ['prompt', ...MODEL_KEYS]) if (changes[key] !== undefined) config[key] = changes[key]
  if (MODEL_KEYS.some(key => changes[key] !== undefined)) {
    if (changes.modelId !== undefined && changes.modelId !== configOf(board).modelId && changes.platformId === undefined) {
      delete config.platformId
    }
    Object.assign(config, resolveVideoModel(catalogue, config))
  }
  const next: Row = { ...board, isGenerate: 0, modelConfig: typeof board.modelConfig === 'string' ? JSON.stringify(config) : config }
  for (const [key, field] of Object.entries(BOARD_FIELDS)) if (changes[key] !== undefined) next[field] = changes[key]
  return next
}
function targetOf(board: Row, next: Row): Target {
  const oldMarkers = markers(configOf(board).prompt)
  const newMarkers = markers(configOf(next).prompt)
  const selectedKeys = materialsOf(board).map(row => object(row).materialKey ?? null)
  const promptKeys = newMarkers.map(marker => marker.key)
  const needsReselect = stableJson(promptKeys) !== stableJson(selectedKeys)
    || (selectedKeys.length > 0 && stableJson(oldMarkers) !== stableJson(newMarkers))
  return { storyboard_id: positiveInteger(board.id), before_hash: stableSha256(snapshot(board)),
    expected_hash: stableSha256(comparable(next)), request_hash: bodyHash(next), before: view(board), after: view(next),
    selection_status: needsReselect ? 'needs_reselect' : 'unchanged', prompt_keys: promptKeys, selected_keys: selectedKeys }
}
async function build(client: JubianClient, scriptId: number, edits: Edit[]): Promise<Plan> {
  const catalogue = edits.some(edit => MODEL_KEYS.some(key => edit.changes[key] !== undefined))
    ? (await client.request({ method: 'GET', path: '/model/charge/getSelectList?taskType=1' })).data : undefined
  const episodes = edits.some(edit => edit.changes.episode_id !== undefined) ? await episodeIds(client, scriptId) : undefined
  const targets: Target[] = []
  for (const edit of edits) {
    if (edit.changes.episode_id !== undefined && !episodes?.has(Number(edit.changes.episode_id))) {
      invalid(`episode_id ${JSON.stringify(edit.changes.episode_id)} is absent from this project's episode catalogue`)
    }
    const board = await readBoard(client, scriptId, edit.storyboard_id)
    targets.push(targetOf(board, patched(board, edit.changes, catalogue)))
  }
  const plan = { version: 1, operation: 'storyboard_edit', script_id: scriptId, edits, targets } as const
  return { ...plan, fingerprint: stableSha256(plan) }
}
function destination(root: string, key: string): string { return join(root, 'video_tasks', `${key}.storyboard-edit.prepared.json`) }
function parsePlan(value: unknown, limits: ImageBatchOptions): Plan {
  const row = object(value)
  if (row.version !== 1 || row.operation !== 'storyboard_edit' || !Array.isArray(row.targets)) fail('Invalid storyboard edit preview')
  const edits = editsOf(row.edits, limits)
  const targets = row.targets.map((raw): Target => {
    const target = object(raw)
    if (typeof target.before_hash !== 'string' || !/^[a-f0-9]{64}$/.test(target.before_hash)
      || typeof target.expected_hash !== 'string' || !/^[a-f0-9]{64}$/.test(target.expected_hash)
      || typeof target.request_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(target.request_hash)
      || !Array.isArray(target.prompt_keys) || !Array.isArray(target.selected_keys)
      || (target.selection_status !== 'unchanged' && target.selection_status !== 'needs_reselect')) fail('Invalid target snapshot')
    const promptKeys = target.prompt_keys.map((key): string => typeof key === 'string' ? key : fail('Invalid prompt key'))
    return { storyboard_id: positiveInteger(target.storyboard_id), before_hash: target.before_hash,
      expected_hash: target.expected_hash, request_hash: target.request_hash, before: object(target.before), after: object(target.after),
      selection_status: target.selection_status, prompt_keys: promptKeys, selected_keys: target.selected_keys }
  })
  const plan = { version: 1, operation: 'storyboard_edit', script_id: positiveInteger(row.script_id), edits, targets } as const
  const result = { ...plan, fingerprint: stableSha256(plan) }
  if (row.fingerprint !== result.fingerprint || stableJson(row) !== stableJson(result)
    || stableJson(edits.map(edit => edit.storyboard_id)) !== stableJson(targets.map(target => target.storyboard_id))) fail('Preview fingerprint mismatch')
  return result
}
function verifyClaim(record: { method: string; request_sha256: string; script_id: number | null }, scriptId: number, hash: string): void {
  if (record.method !== 'storyboard_save' || record.script_id !== scriptId || record.request_sha256 !== hash) {
    fail('Idempotency key belongs to a different write')
  }
}
async function apply(client: JubianClient, ledger: JubianLedger, args: MethodArgs, limits: ImageBatchOptions): Promise<Row> {
  const key = requireKey(args.idempotency_key)
  const scriptId = positiveInteger(need(args.script_id, 'script_id'))
  const binding = await validateProjectBinding(need(args.project_dir, 'project_dir'), scriptId)
  const raw = await readPreparedJson(binding.project_root, key, need(args.preview_path, 'preview_path'), 'storyboard-edit')
  const plan = parsePlan(raw, limits)
  if (key !== plan.fingerprint || scriptId !== plan.script_id) fail('Preview project/path/key mismatch')
  const prior = await ledger.find(key)
  if (prior !== undefined) {
    verifyClaim(prior, scriptId, `sha256:${key}`)
    const items: Row[] = []
    for (const target of plan.targets) {
      const recorded = await ledger.find(`${key}:${target.storyboard_id}`)
      let status = 'not_attempted'; let verifiedReadback = false
      if (recorded !== undefined) {
        verifyClaim(recorded, scriptId, target.request_hash)
        try {
          verifiedReadback = stableSha256(comparable(await readBoard(client, scriptId, target.storyboard_id))) === target.expected_hash
          status = verifiedReadback ? (target.selection_status === 'needs_reselect' ? 'needs_reselect' : 'applied') : 'readback_mismatch'
        } catch (error) {
          status = 'unknown'
          items.push({ storyboard_id: target.storyboard_id, status, verified_readback: false,
            error: error instanceof JubianError ? error.code : 'READBACK_FAILED' })
          continue
        }
      }
      items.push({ storyboard_id: target.storyboard_id, status, verified_readback: verifiedReadback })
    }
    return { status: 'replayed', replayed: true, paid_requests: 0, items,
      next: '没有重复保存。unknown 先 get 对账；needs_reselect 先 select_assets；原计划不会继续发送。' }
  }
  const live = await build(client, scriptId, plan.edits)
  if (live.fingerprint !== key) fail('Stale storyboard, episode catalogue or model selectors; preview again')
  const claim = await ledger.begin({ idempotencyKey: key, method: 'storyboard_save', scriptId, requestSha256: `sha256:${key}` })
  if (claim.replayed) return apply(client, ledger, args, limits)
  const items: Row[] = plan.targets.map(target => ({ storyboard_id: target.storyboard_id, status: 'not_attempted', verified_readback: false }))
  let cursor = 0
  const state = { stopped: false }
  const worker = async (): Promise<void> => {
    while (!state.stopped) {
      const index = cursor++; const target = plan.targets[index]; const edit = plan.edits[index]
      if (!target || !edit) return
      const item = need(items[index]); const send = { started: false }
      try {
        const board = await readBoard(client, scriptId, target.storyboard_id)
        if (stableSha256(snapshot(board)) !== target.before_hash) { item.status = 'stale'; state.stopped = true; return }
        const body: Row = { ...board, isGenerate: 0 }
        const config = { ...configOf(board) }
        for (const [key, value] of Object.entries(target.after)) {
          if (key === 'name' || key === 'episode_id' || key === 'sort_order') {
            if (edit.changes[key] !== undefined) body[BOARD_FIELDS[key]] = value
          }
          else if (value !== null) config[key] = value
        }
        body.modelConfig = typeof board.modelConfig === 'string' ? JSON.stringify(config) : config
        if (bodyHash(body) !== target.request_hash) fail('Preview request differs from the approved edit')
        if (target.selection_status === 'needs_reselect') await markReselection(ledger, scriptId, target.storyboard_id, config.prompt)
        const result = await writeUnderLedger(ledger, `${key}:${target.storyboard_id}`, 'storyboard_save', () => body,
          (payload) => { send.started = true; return client.request({ method: 'PUT', path: '/aigc/storyboard', body: need(payload) }) },
          undefined, { scriptId })
        if (result.replayed || result.outcome !== 'accepted') { item.status = 'unknown'; state.stopped = true; return }
        const verified = await readBoard(client, scriptId, target.storyboard_id)
        item.verified_readback = stableSha256(comparable(verified)) === target.expected_hash
        item.status = item.verified_readback ? (target.selection_status === 'needs_reselect' ? 'needs_reselect' : 'applied') : 'readback_mismatch'
      } catch (error) {
        item.status = send.started ? 'unknown' : 'stale'; state.stopped = true
        item.error = error instanceof JubianError ? error.code : 'REQUEST_OR_READBACK_FAILED'
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limits.concurrency, items.length) }, () => worker()))
  const verified = items.every(item => item.verified_readback === true)
  return { status: !verified ? 'partial' : items.some(item => item.status === 'needs_reselect') ? 'needs_reselect' : 'applied',
    replayed: false, paid_requests: 0, items,
    next: '卡片原地保存，不生成。needs_reselect 表示保留的素材与新提示词标记不匹配，先 select_assets 再 prepare_video。unknown 先 get 对账，保留原 key。' }
}

/**
 * Preview one card or a bounded batch, or apply their approved frozen edit without generation.
 * @param client - Transport for current snapshots, catalogues and free storyboard PUTs.
 * @param ledger - Claimed previews and target writes; a replay never resends.
 * @param args - Explicit card changes for preview, or project-bound preview path and fingerprint for apply.
 * @param limits - Deployment bounds shared with free storyboard creation.
 * @returns Changed fields, selection diagnostics or verified per-card save outcomes.
 */
export async function storyboardEditMethod(client: JubianClient, ledger: JubianLedger, args: MethodArgs,
  limits: ImageBatchOptions): Promise<Row> {
  if (args.method === 'edit_apply') return apply(client, ledger, args, limits)
  if (args.method !== 'edit_preview' && args.method !== 'edit_batch_preview') invalid('Unknown storyboard edit method')
  const edits = editsOf(args.method === 'edit_preview'
    ? [{ storyboard_id: need(args.storyboard_id, 'storyboard_id'), changes: need(args.changes, 'changes') }]
    : need(args.edits, 'edits'), limits)
  const scriptId = positiveInteger(need(args.script_id, 'script_id'))
  const binding = await validateProjectBinding(need(args.project_dir, 'project_dir'), scriptId)
  const plan = await build(client, scriptId, edits)
  const path = destination(binding.project_root, plan.fingerprint)
  await atomicWriteJson(path, plan)
  return { ...plan, status: plan.targets.some(target => target.selection_status === 'needs_reselect') ? 'needs_reselect' : 'ready',
    preview_path: path, paid_requests: 0,
    next: '核对卡片身份与 before/after；edit_apply 使用本 preview_path 和 idempotency_key=fingerprint。预览未改远端；needs_reselect 保存后必须重新 select_assets。' }
}
