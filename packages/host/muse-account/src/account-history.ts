/** Current-member organization and recorded metering history from bounded Beijing date windows. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { readMuseAccountJson } from './account-details.ts'
import { MuseGatewayError } from './gateway.ts'
import type { MuseAccountProfile, MuseAccountRelayDetails, MuseAccountRelayHistory, MuseFeishuDepartmentId } from './types.ts'

const dayMs = 86_400_000, beijingOffsetMs = 8 * 60 * 60 * 1000
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const instant = z.iso.datetime()
const tokenFields = [['inputTokens', 'inputTokensReports'], ['outputTokens', 'outputTokensReports'], ['totalTokens', 'totalTokensReports']] as const
const identifier = z.string().regex(/^[a-f0-9]{16}$/u)
const department = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u).transform(value => brandString<MuseFeishuDepartmentId>(value)),
  name: z.string().min(1).max(200).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/u.test(value)),
})
const departmentPath = z.tuple([department]).rest(department).refine(path => path.length <= 100)
const departmentPaths = z.array(departmentPath).refine((paths) => {
  const leaves = new Set<string>(), nodes = new Map<string, { name: string; parent: string | null }>()
  for (const path of paths) {
    const visited = new Set<string>()
    let parent: string | null = null
    for (const node of path) {
      if (visited.has(node.id)) return false
      visited.add(node.id)
      const previous = nodes.get(node.id)
      if (previous !== undefined && (previous.name !== node.name || previous.parent !== parent)) return false
      nodes.set(node.id, { name: node.name, parent })
      parent = node.id
    }
    const leaf = path.reduce((_previous, node) => node)
    if (leaves.has(leaf.id)) return false
    leaves.add(leaf.id)
  }
  return true
})
const summarySchema = z.object({ requests: count, reported: count, partial: count, unknown: count,
  inputTokens: count.nullable(), outputTokens: count.nullable(), totalTokens: count.nullable(),
  inputTokensReports: count, outputTokensReports: count, totalTokensReports: count,
}).refine(value => value.reported + value.partial + value.unknown === value.requests
  && value.inputTokensReports <= value.requests && value.outputTokensReports <= value.requests && value.totalTokensReports <= value.requests
  && tokenFields.every(([field, reports]) => value[field] === null || value[reports] > 0))
const memberUsage = z.discriminatedUnion('status', [
  z.object({ status: z.literal('recorded'), metrics: summarySchema }),
  z.object({ status: z.enum(['unavailable', 'unknown', 'no-requests']), metrics: z.null() }),
])
const usageMetadata = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), recordingSince: instant.nullable(), coverage: z.literal('server-relay-only'),
    limited: z.boolean(), writeFailures: count }),
  z.object({ available: z.literal(false), recordingSince: instant.nullable().optional(),
    coverage: z.literal('server-relay-only').nullable().optional(), limited: z.boolean().optional(), writeFailures: count.optional() }),
])
const workbenchSchema = z.object({ scope: z.literal('self'), me: z.object({ id: identifier }),
  filters: z.object({ from: z.iso.date(), to: z.iso.date() }).optional(),
  organization: z.object({ status: z.enum(['ready', 'partial', 'unavailable']), updatedAt: instant.nullable() }),
  members: z.tuple([z.object({ id: identifier, username: z.string().min(1).max(200),
    departmentPaths: departmentPaths.nullable(), usage: z.unknown().optional() })]),
  usage: usageMetadata.optional(),
})

interface DateRange { readonly from: string; readonly to: string }
interface WorkbenchProjection {
  readonly organization: MuseAccountProfile['organization']
  readonly history?: MuseAccountRelayHistory
}
interface WorkbenchOptions {
  readonly account: MuseAccountRelayDetails['account']
  readonly createdAt?: string
  readonly requestTimeoutMs: number
  readonly read: (range: DateRange, signal: AbortSignal) => Promise<Response | undefined>
}

function emptySummary(): MuseAccountRelayHistory['summary'] {
  return { requests: 0, reported: 0, partial: 0, unknown: 0, inputTokens: null, outputTokens: null,
    totalTokens: null, inputTokensReports: 0, outputTokensReports: 0, totalTokensReports: 0 }
}

function beijingDay(timestamp: number): string { return new Date(timestamp + beijingOffsetMs).toISOString().slice(0, 10) }
function shiftDay(day: string, delta: number): string { return new Date(Date.parse(day) + delta * dayMs).toISOString().slice(0, 10) }
function latestDay(left: string, right: string): string { return left > right ? left : right }
function assertActive(signal: AbortSignal): void { if (signal.aborted) throw new MuseGatewayError('gateway-unavailable') }

async function readWindow(response: Response, account: MuseAccountRelayDetails['account'], range: DateRange): Promise<WorkbenchProjection> {
  const raw = await readMuseAccountJson(response)
  try {
    const value = workbenchSchema.parse(raw), member = value.members[0]
    if (value.me.id !== account.id || member.id !== account.id || member.username !== account.username) throw new MuseGatewayError('gateway-rejected')
    const paths = value.organization.status === 'unavailable'
      || member.departmentPaths !== null && member.departmentPaths.length > 100 ? null : member.departmentPaths
    const organization: MuseAccountProfile['organization'] = {
      status: paths === null ? 'unavailable' : 'available', updatedAt: value.organization.updatedAt,
      departments: paths === null ? [] : paths.map((path) => {
        const leaf = path.reduce((_previous, node) => node)
        return { id: leaf.id, name: leaf.name, path: path.map(node => node.name).join(' / '), pathIds: path.map(node => node.id) }
      }),
    }
    if (value.usage?.available !== true) return { organization }
    if (value.filters?.from !== range.from || value.filters.to !== range.to) throw new MuseGatewayError('gateway-rejected')
    const measured = memberUsage.parse(member.usage)
    if (measured.status === 'unavailable') throw new MuseGatewayError('gateway-rejected')
    if (value.usage.recordingSince === null && (measured.status !== 'no-requests' || value.usage.limited)) throw new MuseGatewayError('gateway-rejected')
    return { organization, history: { ...range, timeZone: 'Asia/Shanghai', recordingSince: value.usage.recordingSince,
      limited: value.usage.limited || measured.status === 'unknown',
      health: { state: value.usage.writeFailures > 0 ? 'degraded' : 'ok' },
      summary: measured.status === 'recorded' ? measured.metrics : emptySummary(),
    } }
  } catch (_error) { throw new MuseGatewayError('gateway-rejected') }
}

function addCount(left: number, right: number): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) throw new MuseGatewayError('gateway-rejected')
  return result
}

function addSummary(left: MuseAccountRelayHistory['summary'], right: MuseAccountRelayHistory['summary']): MuseAccountRelayHistory['summary'] {
  const result = { ...left }
  for (const field of ['requests', 'reported', 'partial', 'unknown'] as const) result[field] = addCount(left[field], right[field])
  for (const [field, reports] of tokenFields) {
    const before = left[reports]
    result[reports] = addCount(before, right[reports])
    if (right[reports] === 0) continue
    if (before === 0) result[field] = right[field]
    else if (left[field] === null || right[field] === null) result[field] = null
    else {
      const sum = left[field] + right[field]
      result[field] = Number.isSafeInteger(sum) ? sum : null
    }
  }
  return result
}

/**
 * Read the current member's organization and all available recorded usage within one request deadline.
 * @param options - Verified account, optional creation time, configured timeout and authenticated self-workbench reader.
 * @returns Safe organization data and optional recorded history, never task content or inferred Muse groups.
 */
export async function readMuseAccountRelayWorkbench(options: WorkbenchOptions): Promise<Partial<WorkbenchProjection>> {
  const { account, createdAt, requestTimeoutMs, read } = options
  const signal = AbortSignal.timeout(requestTimeoutMs), to = beijingDay(Date.now())
  const createdDay = createdAt === undefined ? undefined : beijingDay(Date.parse(createdAt))
  const firstRange = { from: shiftDay(to, -29), to }
  if (createdDay !== undefined) firstRange.from = latestDay(firstRange.from, createdDay)
  if (firstRange.from > to) throw new MuseGatewayError('gateway-rejected')
  async function window(range: DateRange): Promise<WorkbenchProjection | undefined> {
    assertActive(signal)
    const response = await read(range, signal)
    const result = response === undefined ? undefined : await readWindow(response, account, range)
    assertActive(signal)
    return result
  }
  const first = await window(firstRange)
  if (first?.history === undefined) return first ?? {}
  const history = first.history
  if (history.recordingSince === null) {
    return first
  }
  let from = beijingDay(Date.parse(history.recordingSince))
  if (createdDay !== undefined) from = latestDay(from, createdDay)
  if (from > to) throw new MuseGatewayError('gateway-rejected')
  let summary = history.summary, limited = history.limited, degraded = history.health.state === 'degraded'
  for (let end = shiftDay(firstRange.from, -1); end >= from;) {
    const range = { from: latestDay(from, shiftDay(end, -29)), to: end }, next = await window(range)
    if (next?.history === undefined || next.history.recordingSince !== history.recordingSince) throw new MuseGatewayError('gateway-rejected')
    summary = addSummary(summary, next.history.summary)
    limited ||= next.history.limited
    degraded ||= next.history.health.state === 'degraded'
    end = shiftDay(range.from, -1)
  }
  assertActive(signal)
  return { organization: first.organization, history: { ...history, from, summary, limited, health: { state: degraded ? 'degraded' : 'ok' } } }
}
