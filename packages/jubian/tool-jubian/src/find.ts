/**
 * `jubian_find` — locate a screenplay by name in the two lists a production asks about.
 *
 * One read-only call answers "which project is this?" without knowing a
 * `script_id` first: the caller's own canvas projects, or the claimable pool.
 * Matching is a case-insensitive substring of `scriptName` or `manuscriptName`
 * after whitespace normalization — deliberately nothing more, because pinyin,
 * aliases and edit distance would each turn a miss into a plausible-looking
 * wrong project, and every later paid call is addressed by the id returned here.
 *
 * Completeness is a claim about the provider, so it is read rather than assumed:
 * `total` is the real list size and `page_size` only bounds one request, so the
 * scan pages to the end and stops at {@link MAX_SCAN_PAGES} with `complete: false`
 * instead of looping. A silently short read is the one outcome a caller cannot
 * detect from the result, which is why an unrecognized payload fails instead of
 * reading as "no such screenplay".
 */
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { readScriptList } from '@deepseek-ai/dsh-jubian-api'
import type { ScriptRow } from '@deepseek-ai/dsh-jubian-api'

/** The page count one scan reads before it reports itself incomplete. */
export const MAX_SCAN_PAGES = 50

/** How many matches one result carries before it flags `truncated`. */
export const MAX_MATCHES = 100

/** The two lists a lookup can scan. */
export type FindScope = 'mine' | 'pool'

/** One list endpoint per scope. */
const PATHS: Record<FindScope, string> = {
  mine: '/aigc/script/list',
  pool: '/script/center/pool/list',
}

/** Arguments `jubian_find` accepts, as the tool call supplies them. */
export interface FindArgs {
  /** Which list to scan; anything but `mine` or `pool` is refused. */
  scope?: string
  /** Name fragment to match. Omitted, the scan returns the scope's first page instead. */
  name?: string
  /** First page to read; an integer at least 1, default 1. */
  page_num?: number
  /** Rows per request; an integer within 1..1000, default 20. It bounds one request, not the scan. */
  page_size?: number
  /** `pool` only: the provider's own status name to filter by. */
  status?: string
  /** `mine` only: the provider's own `productionType` code, forwarded verbatim. */
  production_type?: number
  /** `mine` only: the provider's own `shareTargetType` code, forwarded verbatim. */
  share_target_type?: number
}

/**
 * Read the one scope this call may scan.
 * @param value - Caller-supplied scope.
 * @returns The scope, once it names a list this tool knows.
 * @throws {JubianError} `INVALID_ARGUMENT` when it names neither list.
 */
function scopeOf(value: string | undefined): FindScope {
  if (value === 'mine' || value === 'pool') return value
  throw new JubianError('INVALID_ARGUMENT', 'scope 必须是 mine（自己的画布项目）或 pool（可认领剧本池）')
}

/**
 * Read the paging arguments, within the range the provider accepts.
 * @param args - The dispatched arguments.
 * @returns The first page number and the per-request page size.
 * @throws {JubianError} `INVALID_ARGUMENT` for a value outside that range.
 */
function paging(args: FindArgs): { num: number; size: number } {
  const num = args.page_num ?? 1
  const size = args.page_size ?? 20
  if (!Number.isSafeInteger(num) || num < 1) {
    throw new JubianError('INVALID_ARGUMENT', 'page_num 必须是不小于 1 的整数')
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > 1000) {
    throw new JubianError('INVALID_ARGUMENT', 'page_size 必须是 1..1000 的整数')
  }
  return { num, size }
}

/**
 * Read one of the provider's own filter codes.
 *
 * The tool forwards these verbatim and interprets neither, so the only rule it
 * can enforce is that the code is a whole number the provider could accept.
 * @param name - The query parameter name, which is the provider's own spelling.
 * @param value - The caller's value, or undefined when it was not supplied.
 * @returns The query fragment, empty when the caller supplied no value.
 * @throws {JubianError} `INVALID_ARGUMENT` when the value is not a safe integer.
 */
function codeQuery(name: string, value: number | undefined): string {
  if (value === undefined) return ''
  if (!Number.isSafeInteger(value)) {
    throw new JubianError('INVALID_ARGUMENT', `${name} 必须是整数——其取值由提供方定义，本工具不解释也不校验`)
  }
  return `&${name}=${value}`
}

/** The one normalization both the query and the provider's names go through. */
function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Whether either name field carries the already-normalized needle. */
function matchesName(row: ScriptRow, needle: string): boolean {
  return (row.script_name !== null && normalized(row.script_name).includes(needle))
    || (row.manuscript_name !== null && normalized(row.manuscript_name).includes(needle))
}

/**
 * Look up screenplays by name in one of the two lists.
 *
 * `name` is matched against both name fields after trimming, collapsing internal
 * whitespace and folding case; there is no pinyin, alias or fuzzy matching. A
 * result says what it actually read: `total` is the provider's own list size,
 * `scanned_pages` how many requests this call made, and `complete` whether those
 * pages covered `total` — a scan that hit {@link MAX_SCAN_PAGES} reports
 * `complete: false` and names that bound in `scan_page_limit`.
 * @param client - Jubian transport.
 * @param args - Scope, optional name fragment, paging, the pool-only status filter and the
 *   mine-only provider filter codes.
 * @returns The matches, the fields read for each, and how completely the scope was scanned.
 * @throws {JubianError} `INVALID_ARGUMENT` for a scope, a filter or a paging value this tool
 *   cannot send, `CONTRACT_CHANGED` for a payload that is not a screenplay list.
 */
export async function findMethod(client: JubianClient, args: FindArgs): Promise<Record<string, unknown>> {
  const scope = scopeOf(args.scope)
  const status = args.status
  if (status !== undefined && scope !== 'pool') {
    throw new JubianError('INVALID_ARGUMENT', 'status 只适用于 scope=pool：自己的画布项目没有池子状态')
  }
  const mineOnly = args.production_type !== undefined || args.share_target_type !== undefined
  if (mineOnly && scope !== 'mine') {
    throw new JubianError('INVALID_ARGUMENT',
      'production_type 与 share_target_type 只适用于 scope=mine（自己的画布项目，含漫剧视频）'
      + '：可认领剧本池不按它们过滤')
  }
  const codes = codeQuery('productionType', args.production_type)
    + codeQuery('shareTargetType', args.share_target_type)
  const { num, size } = paging(args)
  const raw = args.name
  const needle = raw === undefined ? undefined : normalized(raw)
  if (needle === '') throw new JubianError('INVALID_ARGUMENT', 'name 不能只有空白字符')
  const offset = (num - 1) * size

  const matches: ScriptRow[] = []
  let total = 0
  let scannedPages = 0
  let rowsRead = 0
  for (;;) {
    const result = await client.request({ method: 'GET',
      path: `${PATHS[scope]}?pageNum=${num + scannedPages}&pageSize=${size}`
        + (status === undefined ? '' : `&status=${encodeURIComponent(status)}`) + codes })
    const page = readScriptList(result.data)
    total = page.total
    scannedPages += 1
    rowsRead += page.rows.length
    if (needle === undefined) {
      matches.push(...page.rows)
      break
    }
    for (const row of page.rows) {
      if (matchesName(row, needle)) matches.push(row)
    }
    // `total` counts the whole list, so the rows before the first requested page
    // are already accounted for.
    if (offset + rowsRead >= page.total) break
    // An empty page proves the provider has no more rows to hand out; a short
    // page does not, so only this ends the scan early.
    if (page.rows.length === 0) break
    if (scannedPages >= MAX_SCAN_PAGES) break
  }

  const returned = matches.slice(0, MAX_MATCHES)
  const poolOnly = scope === 'pool'
  return { scope, name: raw ?? null, total, scanned_pages: scannedPages,
    complete: offset + rowsRead >= total, returned: returned.length,
    truncated: matches.length > returned.length, scan_page_limit: MAX_SCAN_PAGES,
    matches: returned.map(row => ({ script_id: row.script_id, script_name: row.script_name,
      manuscript_name: row.manuscript_name, episode_count: row.episode_count, status: row.status,
      // Every `mine` row carries the style the caller needs to tell 真人 from 漫剧;
      // the pool rows were not measured as carrying it, so it stays out there.
      ...(poolOnly ? { can_claim: row.can_claim, claim_leader_name: row.claim_leader_name,
        claim_member_name: row.claim_member_name } : { script_style: row.script_style }) })) }
}
