/** Free, frozen, scoped changes to existing storyboard model settings. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { resolveVideoModel, stableJson } from '@deepseek-ai/dsh-jubian-api'
import { atomicWriteJson, validateProjectBinding } from './native.ts'
import type { MethodArgs } from './methods.ts'
import { need, requireKey, writeUnderLedger } from './write.ts'

const INTENT_KEYS = ['modelId', 'platformId', 'ratio', 'resolution', 'genType', 'duration', 'genNum'] as const
const MODEL_KEYS = [...INTENT_KEYS, 'standardId', 'modelGenerationTypeId', 'videoStandardId'] as const
const PROVIDER_AUDIT_KEYS = ['updateTime', 'updateBy', 'createTime', 'createBy'] as const
type Row = Record<string, unknown>
interface Selector { scope: 'storyboards' | 'episodes' | 'project'; storyboard_ids: number[]; episode_ids: number[] }
interface Target { storyboard_id: number; episode_id: number; before_hash: string; preserved_hash: string; before: Row; after: Row }
interface Plan {
  version: 1
  operation: 'storyboard_model_settings'
  script_id: number
  selector: Selector
  changes: Row
  targets: Target[]
  fingerprint: string
}

function fail(detail: string): never { throw new JubianError('CONTRACT_CHANGED', detail) }
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Expected a JSON object')
  return value as Row
}
function id(value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return fail('Invalid remote ID')
  return number
}
function ids(value: unknown): number[] {
  if (!Array.isArray(value)) return fail('Expected remote ID list')
  const result = value.map(id).sort((a, b) => a - b)
  if (new Set(result).size !== result.length) return fail('Duplicate remote IDs')
  return result
}
function changesOf(value: unknown): Row {
  const changes = object(value)
  if (!Object.keys(changes).length || Object.keys(changes).some(key => !(INTENT_KEYS as readonly string[]).includes(key))) {
    return fail('changes accepts only modelId/platformId/ratio/resolution/genType/duration/genNum')
  }
  for (const [key, value] of Object.entries(changes)) {
    if (['genType', 'duration', 'genNum'].includes(key)) id(value)
    else if (typeof value !== 'string' || !value.trim()) fail(`Invalid ${key}`)
  }
  return changes
}
function selectorOf(args: { scope?: unknown; storyboard_ids?: unknown; episode_ids?: unknown }): Selector {
  const scope = args.scope
  if (scope !== 'storyboards' && scope !== 'episodes' && scope !== 'project') return fail('Explicit scope required')
  const storyboard_ids = args.storyboard_ids === undefined ? [] : ids(args.storyboard_ids)
  const episode_ids = args.episode_ids === undefined ? [] : ids(args.episode_ids)
  if ((scope === 'storyboards' && !storyboard_ids.length) || (scope === 'episodes' && !episode_ids.length)
    || (scope !== 'storyboards' && storyboard_ids.length) || (scope !== 'episodes' && episode_ids.length)) {
    return fail('Scope and exact remote IDs disagree')
  }
  return { scope, storyboard_ids, episode_ids }
}
function configOf(board: Row): Row {
  try { return object(typeof board.modelConfig === 'string' ? JSON.parse(board.modelConfig) : board.modelConfig) }
  catch (error) { return fail(error instanceof JubianError ? error.message : 'Invalid modelConfig JSON') }
}
function settings(config: Row): Row {
  return Object.fromEntries(MODEL_KEYS.filter(key => config[key] !== undefined).map(key => [key, config[key]]))
}
function hash(value: unknown): string { return createHash('sha256').update(stableJson(value)).digest('hex') }
function snapshot(board: Row): Row {
  const { isGenerate: _generate, ...rest } = board
  return { ...rest, modelConfig: configOf(board) }
}
function preservedHash(board: Row): string {
  const rest = Object.fromEntries(Object.entries(snapshot(board))
    .filter(([key]) => key !== 'modelConfig' && !(PROVIDER_AUDIT_KEYS as readonly string[]).includes(key)))
  const nonModel = Object.fromEntries(Object.entries(configOf(board))
    .filter(([key]) => !(MODEL_KEYS as readonly string[]).includes(key)))
  return hash({ ...rest, modelConfig: nonModel })
}
function matches(board: Row, target: Target): boolean {
  return preservedHash(board) === target.preserved_hash && stableJson(settings(configOf(board))) === stableJson(target.after)
}
function fingerprint(plan: Omit<Plan, 'fingerprint'>): string { return hash(plan) }

async function targets(client: JubianClient, scriptId: number, selector: Selector): Promise<number[]> {
  if (selector.scope === 'storyboards') return selector.storyboard_ids
  const collected: Row[] = []
  const seen = new Set<number>()
  let total: number | undefined
  for (let page = 1; page <= 40; page++) {
    const data = (await client.request({ method: 'GET',
      path: `/aigc/storyboard/list?scriptId=${scriptId}&pageNum=${page}&pageSize=100` })).data
    const envelope = Array.isArray(data) ? { rows: data } : object(data)
    const rows = envelope.rows ?? envelope.list
    if (!Array.isArray(rows)) fail('Unreadable storyboard list')
    if (envelope.total !== undefined) {
      const count = envelope.total
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0
        || (total !== undefined && count !== total)) fail('Storyboard list total drift')
      total = count
    }
    for (const raw of rows) {
      const row = object(raw); const key = id(row.id)
      if (seen.has(key) || id(row.scriptId) !== scriptId) fail('Storyboard list identity mismatch')
      seen.add(key); collected.push(row)
    }
    if (total !== undefined && collected.length > total) fail('Storyboard list total mismatch')
    if (total === collected.length || (total === undefined && rows.length < 100)) {
      const selected = collected.filter(row => selector.scope === 'project' || selector.episode_ids.includes(id(row.episodeId)))
      if (!selected.length || (selector.scope === 'episodes'
        && selector.episode_ids.some(episode => !selected.some(row => id(row.episodeId) === episode)))) {
        fail('Scope has no storyboards for one or more requested episodes')
      }
      return selected.map(row => id(row.id)).sort((a, b) => a - b)
    }
    if (rows.length < 100) fail('Incomplete storyboard list')
  }
  return fail('Storyboard list exceeds 40 pages')
}
async function readBoard(client: JubianClient, scriptId: number, storyboardId: number): Promise<Row> {
  const board = object((await client.request({ method: 'GET', path: `/aigc/storyboard/${storyboardId}` })).data)
  if (id(board.id) !== storyboardId || id(board.scriptId) !== scriptId) fail('Storyboard identity mismatch')
  return board
}
function targetOf(board: Row, catalogue: unknown, changes: Row): Target {
  const before = configOf(board)
  const intent = { ...before, ...changes }
  if (changes.modelId !== undefined && changes.modelId !== before.modelId && changes.platformId === undefined) {
    delete intent.platformId
  }
  const after = resolveVideoModel(catalogue, intent)
  return { storyboard_id: id(board.id), episode_id: id(board.episodeId), before_hash: hash(snapshot(board)),
    preserved_hash: preservedHash(board), before: settings(before), after: settings({ ...after }) }
}
async function build(client: JubianClient, scriptId: number, selector: Selector, changes: Row): Promise<Plan> {
  const catalogue = (await client.request({ method: 'GET', path: '/model/charge/getSelectList?taskType=1' })).data
  const items: Target[] = []
  for (const key of await targets(client, scriptId, selector)) {
    const target = targetOf(await readBoard(client, scriptId, key), catalogue, changes)
    if (selector.scope === 'episodes' && !selector.episode_ids.includes(target.episode_id)) fail('Episode membership drift')
    items.push(target)
  }
  const plan = { version: 1, operation: 'storyboard_model_settings', script_id: scriptId,
    selector, changes, targets: items } as const
  return { ...plan, fingerprint: fingerprint(plan) }
}
function parsePlan(value: unknown): Plan {
  const row = object(value)
  if (row.version !== 1 || row.operation !== 'storyboard_model_settings' || !Array.isArray(row.targets)
    || !row.targets.length) return fail('Invalid model settings plan')
  const parsedTargets = row.targets.map((raw) => {
    const target = object(raw)
    if (typeof target.before_hash !== 'string' || !/^[a-f0-9]{64}$/.test(target.before_hash)
      || typeof target.preserved_hash !== 'string' || !/^[a-f0-9]{64}$/.test(target.preserved_hash)) fail('Invalid snapshot hash')
    return { storyboard_id: id(target.storyboard_id), episode_id: id(target.episode_id), before_hash: target.before_hash,
      preserved_hash: target.preserved_hash, before: object(target.before), after: object(target.after) }
  })
  ids(parsedTargets.map(target => target.storyboard_id))
  const plan = { version: 1, operation: 'storyboard_model_settings', script_id: id(row.script_id),
    selector: selectorOf(object(row.selector)), changes: changesOf(row.changes), targets: parsedTargets } as const
  const result = { ...plan, fingerprint: fingerprint(plan) }
  if (row.fingerprint !== result.fingerprint || stableJson(row) !== stableJson(result)) fail('Plan fingerprint mismatch')
  return result
}
function destination(project: string, key: string): string {
  return join(project, 'video_tasks', `${key}.model-settings.prepared.json`)
}
function verifyClaim(record: { method: string; request_sha256: string }, expectedHash?: string): void {
  if (record.method !== 'storyboard_model_settings'
    || (expectedHash !== undefined && record.request_sha256 !== expectedHash)) {
    fail('Idempotency key belongs to a different write')
  }
}
async function applyPlan(client: JubianClient, ledger: JubianLedger, args: MethodArgs): Promise<Row> {
  const key = requireKey(args.idempotency_key)
  const scriptId = id(need(args.script_id, 'script_id'))
  const binding = await validateProjectBinding(need(args.project_dir, 'project_dir'), scriptId)
  const path = resolve(need(args.preview_path, 'preview_path'))
  let raw: unknown
  try { raw = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { return fail(error instanceof Error ? 'Cannot read model settings plan' : 'Invalid plan') }
  const plan = parsePlan(raw)
  if (key !== plan.fingerprint || scriptId !== plan.script_id || path !== destination(binding.project_root, key)) {
    fail('Plan project/path/key mismatch')
  }
  const previous = await ledger.find(key)
  if (previous !== undefined) {
    verifyClaim(previous, `sha256:${key}`)
    const items = []
    for (const target of plan.targets) {
      const recorded = await ledger.find(`${key}:${target.storyboard_id}`)
      let status = 'not_attempted'
      if (recorded !== undefined) {
        verifyClaim(recorded)
        try {
          status = matches(await readBoard(client, scriptId, target.storyboard_id), target) ? 'applied' : 'readback_mismatch'
        } catch { status = 'unknown' }
      }
      items.push({ storyboard_id: target.storyboard_id, status })
    }
    return { status: 'replayed', replayed: true, paid_requests: 0, items,
      next: 'No requests resent. Read current storyboards to reconcile; this plan will not resume remaining targets.' }
  }
  const live = await build(client, scriptId, plan.selector, plan.changes)
  if (live.fingerprint !== key) fail('Stale targets, membership or catalogue; preview again')
  const items: Row[] = plan.targets.map(target => ({ storyboard_id: target.storyboard_id, status: 'not_attempted' }))
  // A batch claim has no transport outcome; only per-target entries record actual PUT responses.
  const claim = await ledger.begin({ idempotencyKey: key, method: 'storyboard_model_settings', requestSha256: `sha256:${key}` })
  if (claim.replayed) return applyPlan(client, ledger, args)
  for (const [index, target] of plan.targets.entries()) {
    const item = need(items[index])
    const state = { sent: false }
    try {
      const board = await readBoard(client, scriptId, target.storyboard_id)
      if (hash(snapshot(board)) !== target.before_hash) { item.status = 'stale'; break }
      const nextConfig = { ...configOf(board), ...target.after }
      const body = { ...board, isGenerate: 0,
        modelConfig: typeof board.modelConfig === 'string' ? JSON.stringify(nextConfig) : nextConfig }
      const saved = await writeUnderLedger(ledger, `${key}:${target.storyboard_id}`, 'storyboard_model_settings',
        () => body, (payload) => {
          state.sent = true
          return client.request({ method: 'PUT', path: '/aigc/storyboard', body: need(payload) })
        })
      if (saved.replayed || saved.outcome !== 'accepted') { item.status = 'unknown'; break }
      const verified = await readBoard(client, scriptId, target.storyboard_id)
      if (!matches(verified, target)) { item.status = 'readback_mismatch'; break }
      item.status = 'applied'
    } catch (error) {
      item.status = state.sent ? 'unknown' : 'stale'
      item.error = error instanceof JubianError ? error.code : 'REQUEST_OR_READBACK_FAILED'
      break
    }
  }
  return { status: items.every(item => item.status === 'applied') ? 'applied' : 'partial',
    replayed: false, paid_requests: 0, items,
    next: 'Existing storyboards only; defaults and produced media are unchanged. On partial outcome, reconcile before a new preview; never change keys to retry.' }
}

/**
 * Preview or apply an explicit scope of existing storyboard settings without generation.
 * @param client - Jubian transport; previews issue only GET requests.
 * @param ledger - Existing write ledger; a claimed plan never resumes or resends.
 * @param args - Project binding, exact scope and partial model intent, or frozen preview/key.
 * @returns Before/after preview or per-target apply outcomes.
 */
export async function modelMethod(client: JubianClient, ledger: JubianLedger, args: MethodArgs): Promise<Row> {
  if (args.method === 'preview') {
    const scriptId = id(need(args.script_id, 'script_id'))
    const selector = selectorOf(args)
    const changes = changesOf(args.changes)
    const binding = await validateProjectBinding(need(args.project_dir, 'project_dir'), scriptId)
    const plan = await build(client, scriptId, selector, changes)
    const path = destination(binding.project_root, plan.fingerprint)
    await atomicWriteJson(path, plan)
    return { ...plan, preview_path: path, paid_requests: 0,
      next: 'Review every before/after setting and scope. Apply with this preview_path and idempotency_key=fingerprint; no remote changes have been made.' }
  }
  if (args.method !== 'apply') return fail('Unknown model settings method')
  return applyPlan(client, ledger, args)
}
