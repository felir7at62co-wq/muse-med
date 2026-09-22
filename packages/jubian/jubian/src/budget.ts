/**
 * The spend cap: what this deployment is authorized to spend, and whether one more
 * paid call fits inside it.
 *
 * The limit is a file the operator writes beside the ledger — `<ledger>/authorization.json`
 * — and never an argument a model passes, so a model cannot authorize its own
 * spending. Each paid call is checked against the ledger before it sends anything:
 *
 *     settled spend + in-flight reservations + this quote <= the project's limit
 *
 * Three facts make that honest rather than decorative. A call whose intent line was
 * written and never settled was sent and may have been charged, so its quote counts
 * as reserved until it settles. A paid call with no quote cannot be compared against
 * a limit at all, so it is refused instead of being counted as zero. And a spending
 * record with no project identity is refused too, because a per-project limit cannot
 * cover a charge nobody attributed.
 *
 * This is a cap against runaway spending, not a security boundary: the file sits on
 * the same disk the agent can write, so it stops an careless loop, not a hostile one.
 *
 * @module @deepseek-ai/dsh-jubian/budget
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JubianLedger, JubianLedgerMethod, JubianLedgerRecord } from './ledger.ts'

/** Methods that spend money when they succeed. */
export const SPENDING_METHODS: ReadonlySet<JubianLedgerMethod> = new Set([
  'image_generate',
  'storyboard_generate',
  'storyboard_native_submit',
  'erase_subtitle',
  'video_upscale',
])

/** File name the authorization lives under, beside the ledger's own records. */
export const AUTHORIZATION_FILE = 'authorization.json'

/** One project's authorization. */
export interface ProjectAuthorization {
  /** Ceiling this project may spend, in the unit below, as a decimal string. */
  readonly limit: string
  /** Unit the limit and every quote are denominated in, such as `CNY`. */
  readonly unit: string
  /** Who authorized it and when, for the record. */
  readonly note?: string | undefined
}

/** Everything one deployment is authorized to spend. */
export interface BudgetAuthorization {
  /** Format version; only 1 is read. */
  readonly version: number
  /** One entry per project id, keyed as a decimal string. */
  readonly projects: Record<string, ProjectAuthorization>
}

/** What the gate decided about one paid call. */
export interface BudgetDecision {
  /** `authorized` may send, `refused` must not, `unauthorized` may send while no cap exists. */
  readonly status: 'authorized' | 'refused' | 'unauthorized'
  /** Model-facing explanation, empty when the call is authorized. */
  readonly reason: string
  /** Limit as recorded, in hundredths; absent while no authorization exists. */
  readonly limitCents?: number | undefined
  /** Accepted spend, in hundredths. */
  readonly settledCents: number
  /** In-flight reservations, in hundredths. */
  readonly reservedCents: number
}

/**
 * Read one quoted amount as integer hundredths.
 * @param amount - The recorded decimal string.
 * @returns Hundredths, or null when there is no usable amount.
 */
export function centsOf(amount: string | null | undefined): number | null {
  if (amount === null || amount === undefined || amount.trim() === '') return null
  const value = Number(amount)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

/**
 * The authorization file's path for one ledger.
 * @param ledgerRoot - Directory holding the ledger's per-day NDJSON files.
 * @returns Absolute path of the authorization file.
 */
export function authorizationPathFor(ledgerRoot: string): string {
  return join(ledgerRoot, AUTHORIZATION_FILE)
}

/**
 * Read the operator's authorization.
 * @param path - Absolute path of the authorization file.
 * @returns The parsed authorization, or undefined when the file is absent.
 * @throws {Error} When the file exists but is not a version 1 authorization, so a
 *   malformed file never reads as "no cap".
 */
export async function readAuthorization(path: string): Promise<BudgetAuthorization | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`${path} 不是合法 JSON：预算文件写坏了不能当成没有上限。`, { cause: error })
  }
  const document = parsed as { version?: unknown; projects?: unknown }
  if (document.version !== 1 || typeof document.projects !== 'object' || document.projects === null) {
    throw new Error(`${path} 必须是 {"version":1,"projects":{"<项目ID>":{"limit":"200","unit":"CNY"}}}。`)
  }
  const projects: Record<string, ProjectAuthorization> = {}
  for (const [id, value] of Object.entries(document.projects as Record<string, unknown>)) {
    const entry = value as { limit?: unknown; unit?: unknown; note?: unknown }
    if (typeof entry.limit !== 'string' || typeof entry.unit !== 'string'
      || centsOf(entry.limit) === null || entry.unit.trim() === '') {
      throw new Error(`${path} 里项目 ${id} 的 limit 与 unit 必须是非空字符串（limit 为十进制金额）。`)
    }
    projects[id] = { limit: entry.limit, unit: entry.unit,
      ...(typeof entry.note === 'string' ? { note: entry.note } : {}) }
  }
  return { version: 1, projects }
}

/** Sum one project's settled spend and in-flight reservations. */
function summarise(records: readonly JubianLedgerRecord[], scriptId: number): {
  settled: number
  reserved: number
  unquoted: string[]
  unattributed: string[]
  units: Set<string>
} {
  const summary = { settled: 0, reserved: 0, unquoted: [] as string[], unattributed: [] as string[],
    units: new Set<string>() }
  for (const record of records) {
    if (!SPENDING_METHODS.has(record.method)) continue
    if (record.script_id === null) {
      // A charge nobody attributed cannot be counted against any project's limit.
      if (record.outcome !== 'unknown') summary.unattributed.push(record.record_id)
      continue
    }
    if (record.script_id !== scriptId) continue
    const cents = centsOf(record.quoted_amount)
    if (cents === null) {
      if (record.outcome === null || record.outcome === 'accepted') summary.unquoted.push(record.record_id)
      continue
    }
    if (record.quote_unit !== null) summary.units.add(record.quote_unit)
    if (record.outcome === 'accepted') summary.settled += cents
    else summary.reserved += cents
  }
  return summary
}

/**
 * Decide whether one paid call may be sent.
 * @param input - The ledger, the method about to run, its project, and the quote observed for it.
 * @returns The decision, with the amounts it was made from.
 * @throws {Error} When the authorization file exists but cannot be read.
 */
export async function checkBudget(input: {
  readonly ledger: JubianLedger
  readonly method: JubianLedgerMethod
  readonly scriptId?: number | undefined
  readonly quote?: { amount?: string | undefined; unit?: string | undefined } | undefined
  readonly authorizationPath?: string | undefined
}): Promise<BudgetDecision> {
  const records = await input.ledger.records()
  const scriptId = input.scriptId ?? null
  const empty = { settledCents: 0, reservedCents: 0 }
  if (!SPENDING_METHODS.has(input.method)) return { status: 'authorized', reason: '', ...empty }

  const path = input.authorizationPath ?? authorizationPathFor(input.ledger.root)
  const authorization = await readAuthorization(path)
  if (authorization === undefined) {
    return { status: 'unauthorized', ...empty,
      reason: `本次是计费调用，而 ${path} 不存在，没有任何金额上限在保护它。`
        + '要设上限就在该文件里写 {"version":1,"projects":{"<项目ID>":{"limit":"200","unit":"CNY","note":"谁在何时授权"}}}；'
        + '没有上限时继续调用是被允许的，但花多少都由你自己承担。' }
  }
  if (scriptId === null) {
    return { status: 'refused', ...empty,
      reason: '这次计费调用没有带项目 ID，无法对上任何授权额度。请在调用里给出 script_id，并确认该项目已写进 '
        + AUTHORIZATION_FILE + '。' }
  }
  const entry = authorization.projects[String(scriptId)]
  if (entry === undefined) {
    return { status: 'refused', ...empty,
      reason: `项目 ${String(scriptId)} 没有授权记录（${path} 里没有这一项）。`
        + '请由人在该文件里写上这个项目的 limit 与 unit，模型不能自己授权消费。' }
  }
  const limitCents = centsOf(entry.limit) ?? 0
  const summary = summarise(records, scriptId)
  const base = { limitCents, settledCents: summary.settled, reservedCents: summary.reserved }
  if (summary.unattributed.length > 0) {
    return { status: 'refused', ...base,
      reason: `账本里有 ${String(summary.unattributed.length)} 笔计费记录没有项目归属（${summary.unattributed.slice(0, 5).join('、')}），`
        + '它们可能属于任何项目，无法证明本项目没超上限。请人工核对这些记录后再继续。' }
  }
  if (summary.unquoted.length > 0) {
    return { status: 'refused', ...base,
      reason: `账本里有 ${String(summary.unquoted.length)} 笔计费记录没有报价（${summary.unquoted.slice(0, 5).join('、')}），`
        + '花费未知，不能把它们当成 0。请先补齐这些调用点的报价，或人工确认金额后再继续。' }
  }
  if (summary.units.size > 0 && !summary.units.has(entry.unit)) {
    return { status: 'refused', ...base,
      reason: `账本里的报价单位是 ${[...summary.units].join('、')}，而授权写的是 ${entry.unit}：单位不一致不能相加比较。` }
  }
  const quoteCents = centsOf(input.quote?.amount)
  if (quoteCents === null) {
    return { status: 'refused', ...base,
      reason: `这次 ${input.method} 没有报价，无法证明它落在 ${entry.limit} ${entry.unit} 之内。`
        + '请让调用点先读目录拿到报价（quote）再提交；没有报价的计费调用一律不放行。' }
  }
  const total = summary.settled + summary.reserved + quoteCents
  if (total > limitCents) {
    return { status: 'refused', ...base,
      reason: `本次预计 ${(quoteCents / 100).toFixed(2)} ${entry.unit}，`
        + `而已结算 ${(summary.settled / 100).toFixed(2)}、在途 ${(summary.reserved / 100).toFixed(2)}，`
        + `合计将超过项目 ${String(scriptId)} 的授权上限 ${entry.limit} ${entry.unit}。`
        + '请先结算或取消在途任务，或由人提高该项目的授权额度。' }
  }
  return { status: 'authorized', ...base, reason: '' }
}
