import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { claimMethod, claimWatchArgs, claimWatchJob, resolveClaimWatchConfig } from '../src/claim.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-claim-')) })
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) })

const config = { claimPollIntervalMs: 1000, claimMaxWindowMs: 60000, claimMaxLeadMs: 60000,
  claimScanPageSize: 2, claimScanPageLimit: 4, claimMaxItems: 10 }
const row = (id: number, canClaim: number, extra: Record<string, unknown> = {}) => ({
  id, scriptName: `剧本${id}`, canClaim, status: canClaim ? 'pending_leader_claim' : 'pending_distribute',
  ...extra,
})

function provider(options: { role?: string
  rows: () => Record<string, unknown>[]
  poolDelayMs?: number
  claim?: (path: string) => Response | Promise<Response> }) {
  const calls: { method: string; path: string }[] = []
  const client = new JubianClient({ credential: async () => 'test-token', fetch: async (url, init) => {
    const path = (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      .replace('https://web.jubianai.net/prod-api', '')
    calls.push({ method: init!.method!, path })
    if (path === '/getInfo') return new Response(JSON.stringify({ code: 200, user: { userId: 91, userName: '编辑甲' } }))
    if (path === '/script/center/pool/viewRole') {
      return new Response(JSON.stringify({ code: 200, data: options.role ?? 'prodlead' }))
    }
    if (path.startsWith('/script/center/pool/list?')) {
      if (options.poolDelayMs !== undefined) {
        await new Promise<void>((resolve) => { setTimeout(resolve, options.poolDelayMs) })
      }
      const rows = options.rows()
      const page = Number(/pageNum=(\d+)/u.exec(path)?.[1] ?? 1)
      const size = Number(/pageSize=(\d+)/u.exec(path)?.[1] ?? 2)
      return new Response(JSON.stringify({ code: 200, total: rows.length,
        rows: rows.slice((page - 1) * size, page * size) }))
    }
    if (path.startsWith('/script/center/pool/claim/') || path.startsWith('/script/center/pool/memberClaim/')) {
      return await options.claim?.(path) ?? new Response(JSON.stringify({ code: 200, data: Number(path.split('/').at(-1)) }))
    }
    throw new Error(`Unexpected request: ${path}`)
  } })
  return { client, calls, ledger: new JubianLedger({ root }) }
}

describe('Jubian pool claims', () => {
  it('inspects the account-specific canClaim flag without posting', async () => {
    const remote = provider({ rows: () => [row(11, 1), row(12, 0)] })
    expect(await claimMethod(remote.client, remote.ledger, { method: 'inspect', script_id: 11 }, config))
      .toMatchObject({ script_id: 11, can_claim: true, role: 'leader', sent: false })
    expect(await claimMethod(remote.client, remote.ledger, { method: 'inspect', script_id: 12 }, config))
      .toMatchObject({ script_id: 12, can_claim: false, sent: false })
    expect(remote.calls.some(call => call.method === 'POST')).toBe(false)
  })

  it('posts only a claimable ID to the endpoint selected by viewRole and verifies ownership', async () => {
    let claimed = false
    const remote = provider({ role: 'prodmember', rows: () => [row(11, claimed ? 0 : 1,
      claimed ? { claimMemberId: 91 } : {})], claim: () => {
      claimed = true
      return new Response(JSON.stringify({ code: 200, data: 11 }))
    } })
    const first = await claimMethod(remote.client, remote.ledger,
      { method: 'claim', script_id: 11, idempotency_key: 'authorized-11', authorization_basis: '用户明确要求认领 11' }, config)
    expect(first).toMatchObject({ script_id: 11, status: 'verified', sent: true, replayed: false })
    expect(remote.calls.filter(call => call.method === 'POST').map(call => call.path))
      .toEqual(['/script/center/pool/memberClaim/11'])
    const repeat = await claimMethod(remote.client, remote.ledger,
      { method: 'claim', script_id: 11, idempotency_key: 'authorized-11', authorization_basis: '用户明确要求认领 11' }, config)
    expect(repeat).toMatchObject({ status: 'verified', sent: false, replayed: true })
    expect(remote.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('refuses unavailable rows, unknown roles and a different ID on the same key before POST', async () => {
    const unavailable = provider({ rows: () => [row(11, 0)] })
    expect(await claimMethod(unavailable.client, unavailable.ledger,
      { method: 'claim', script_id: 11, idempotency_key: 'no-claim', authorization_basis: '用户明确要求认领 11' }, config))
      .toMatchObject({ status: 'not_claimable', sent: false })
    const unknown = provider({ role: 'prodmaker', rows: () => [row(11, 1)] })
    await expect(claimMethod(unknown.client, unknown.ledger,
      { method: 'claim', script_id: 11, idempotency_key: 'unknown-role', authorization_basis: '用户明确要求认领 11' }, config)).rejects.toThrow('viewRole')
    expect([...unavailable.calls, ...unknown.calls].some(call => call.method === 'POST')).toBe(false)
  })

  it('refuses a claim with no stated user authorization before any request', async () => {
    const remote = provider({ rows: () => [row(11, 1)] })
    await expect(claimMethod(remote.client, remote.ledger,
      { method: 'claim', script_id: 11, idempotency_key: 'unauthorized' }, config))
      .rejects.toThrow('authorization_basis')
    expect(remote.calls).toEqual([])
  })

  it('records an uncertain request and refuses a second key for that ID', async () => {
    const remote = provider({ rows: () => [row(11, 1)], claim: () => { throw new Error('transport lost') } })
    const first = await claimMethod(remote.client, remote.ledger,
      { method: 'claim', script_id: 11, idempotency_key: 'maybe-11', authorization_basis: '用户明确要求认领 11' }, config)
    expect(first).toMatchObject({ status: 'unverified', sent: true, replayed: false })
    expect((await remote.ledger.find('maybe-11'))?.outcome).toBe('unknown')
    const repeat = await claimMethod(remote.client, remote.ledger,
      { method: 'claim', script_id: 11, idempotency_key: 'maybe-11', authorization_basis: '用户明确要求认领 11' }, config)
    expect(repeat).toMatchObject({ status: 'unverified', sent: false, replayed: true })
    await expect(claimMethod(remote.client, remote.ledger,
      { method: 'claim', script_id: 11, idempotency_key: 'new-11', authorization_basis: '用户明确要求认领 11' }, config)).rejects.toThrow('local claim attempt')
    await expect(claimMethod(remote.client, remote.ledger,
      { method: 'claim', script_id: 12, idempotency_key: 'maybe-11', authorization_basis: '用户明确要求认领 12' }, config)).rejects.toThrow('different claim')
    expect(remote.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('does not verify a returned row merely because it retains the old claimant ID', async () => {
    let returned = false
    const remote = provider({ rows: () => [row(11, returned ? 0 : 1,
      returned ? { claimLeaderId: 91, status: 'returned' } : {})], claim: () => {
      returned = true
      return new Response(JSON.stringify({ code: 200, data: 11 }))
    } })
    expect(await claimMethod(remote.client, remote.ledger,
      { method: 'claim', script_id: 11, idempotency_key: 'returned-11',
        authorization_basis: '用户明确要求认领 11' }, config))
      .toMatchObject({ status: 'accepted_unverified', sent: true })
  })

  it('requires an explicit bounded window and scope for watching', () => {
    const now = new Date('2026-09-28T12:00:00.000Z')
    expect(() => claimWatchArgs({ scope: 'ids', script_ids: [11],
      start_at: '2026-09-28T12:00:00.000Z', end_at: '2026-09-28T12:01:00.000Z',
      idempotency_prefix: 'job-1', authorization_basis: '用户明确要求认领 11' }, config, now)).not.toThrow()
    expect(() => claimWatchArgs({ scope: 'ids', script_ids: [],
      start_at: '2026-09-28T12:00:00.000Z', end_at: '2026-09-28T12:01:00.000Z',
      idempotency_prefix: 'job-1', authorization_basis: '用户明确要求认领 11' }, config, now)).toThrow('script_ids')
    expect(() => resolveClaimWatchConfig({ claimPollIntervalMs: 0 })).toThrow('claimPollIntervalMs')
  })

  it('claims only a newly observed claimable ID after taking a complete baseline', async () => {
    const now = Date.now()
    let released = false
    let claimed = false
    let observedBaseline!: () => void
    const baseline = new Promise<void>((resolve) => { observedBaseline = resolve })
    const remote = provider({ rows: () => { if (!released) observedBaseline(); return [row(11, 1),
      ...(released ? [row(12, claimed ? 0 : 1, claimed ? { claimLeaderId: 91 } : {})] : [])]
    },
    claim: () => { claimed = true; return new Response(JSON.stringify({ code: 200, data: 12 })) } })
    const hook = claimWatchJob(remote.client, remote.ledger, { scope: 'new_claimable',
      start_at: new Date(now + 300).toISOString(), end_at: new Date(now + 5000).toISOString(),
      idempotency_prefix: 'window-a', authorization_basis: '用户明确授权此窗口的新可领剧本' }, { ...config, claimMaxItems: 1 })
    await baseline
    released = true
    const output = await hook.done
    expect(output.status).toBe('completed')
    expect(JSON.parse(output.result!)).toMatchObject({ attempted: [12],
      outcomes: [{ script_id: 12, status: 'verified' }] })
    expect(remote.calls.filter(call => call.method === 'POST').map(call => call.path))
      .toEqual(['/script/center/pool/claim/12'])
  }, 10000)

  it('stops a targeted watcher on cancellation without submitting an unavailable ID', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'))
    const remote = provider({ rows: () => [row(11, 0)] })
    const hook = claimWatchJob(remote.client, remote.ledger, { scope: 'ids', script_ids: [11],
      start_at: '2026-09-28T12:00:00.000Z', end_at: '2026-09-28T12:00:04.000Z',
      idempotency_prefix: 'window-b', authorization_basis: '用户明确要求认领 11' }, config)
    await vi.advanceTimersByTimeAsync(1000)
    hook.cancel()
    expect((await hook.done).status).toBe('killed')
    expect(remote.calls.some(call => call.method === 'POST')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not submit after the authorized window expires during a slow pool scan', async () => {
    const now = Date.now()
    const remote = provider({ rows: () => [row(11, 1)], poolDelayMs: 150 })
    const hook = claimWatchJob(remote.client, remote.ledger, { scope: 'ids', script_ids: [11],
      start_at: new Date(now).toISOString(), end_at: new Date(now + 100).toISOString(),
      idempotency_prefix: 'late-window', authorization_basis: '用户明确要求本窗口认领 11' }, config)
    expect((await hook.done).status).toBe('completed')
    expect(remote.calls.some(call => call.method === 'POST')).toBe(false)
  }, 10000)

  it('rescans a changing pool before deciding a targeted claim', async () => {
    const now = Date.now()
    let reads = 0
    let claimed = false
    const remote = provider({ rows: () => {
      reads += 1
      return [row(11, claimed ? 0 : 1, claimed ? { claimLeaderId: 91 } : {}), row(12, 0), row(13, 0),
        ...(reads > 1 ? [row(14, 0)] : [])]
    }, claim: () => { claimed = true; return new Response(JSON.stringify({ code: 200, data: 11 })) } })
    const hook = claimWatchJob(remote.client, remote.ledger, { scope: 'ids', script_ids: [11],
      start_at: new Date(now).toISOString(), end_at: new Date(now + 5000).toISOString(),
      idempotency_prefix: 'churn-window', authorization_basis: '用户明确要求本窗口认领 11' },
    { ...config, claimMaxItems: 1 })
    expect((await hook.done).status).toBe('completed')
    expect(remote.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  }, 10000)
})
