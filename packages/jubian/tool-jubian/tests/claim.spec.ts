import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JobHooks } from '@deepseek-ai/dsh-jobs'
import { apply } from '../src/index.ts'
import { bodyHash } from '../src/write.ts'
import type { ClaimWatchArgs } from '../src/claim.ts'
import { claimMethod, claimWatchArgs, claimWatchJob, resolveClaimWatchConfig } from '../src/claim.ts'

let root: string
const hooks: JobHooks[] = []
function watchJob(...args: Parameters<typeof claimWatchJob>): JobHooks {
  const hook = claimWatchJob(...args)
  hooks.push(hook)
  return hook
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-claim-')) })
afterEach(async () => {
  for (const hook of hooks.splice(0)) { hook.cancel(); await hook.done }
  vi.restoreAllMocks(); vi.useRealTimers(); await rm(root, { recursive: true, force: true })
})

const config = { claimPollIntervalMs: 1000, claimMaxWindowMs: 60000, claimMaxLeadMs: 60000,
  claimScanPageSize: 2, claimScanPageLimit: 4, claimMaxItems: 10 }
const row = (id: number, canClaim: number, extra: Record<string, unknown> = {}) => ({
  id, scriptName: `剧本${id}`, canClaim, status: canClaim ? 'pending_leader_claim' : 'pending_distribute',
  ...extra,
})

function provider(options: { role?: unknown
  info?: unknown
  pool?: (page: number) => unknown
  rows: () => Record<string, unknown>[]
  poolDelayMs?: number
  claim?: (path: string) => Response | Promise<Response> }) {
  const calls: { method: string; path: string }[] = []
  const client = new JubianClient({ credential: async () => 'test-token', fetch: async (url, init) => {
    const path = (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      .replace('https://web.jubianai.net/prod-api', '')
    calls.push({ method: init!.method!, path })
    if (path === '/getInfo') return new Response(JSON.stringify({ code: 200, data: options.info ?? { user: { userId: 91, userName: '编辑甲' } } }))
    if (path === '/script/center/pool/viewRole') {
      return new Response(JSON.stringify({ code: 200, data: options.role === undefined ? 'prodlead' : options.role }))
    }
    if (path.startsWith('/script/center/pool/list?')) {
      if (options.poolDelayMs !== undefined) {
        await new Promise<void>((resolve) => { setTimeout(resolve, options.poolDelayMs) })
      }
      const rows = options.rows()
      const page = Number(/pageNum=(\d+)/u.exec(path)?.[1] ?? 1)
      const size = Number(/pageSize=(\d+)/u.exec(path)?.[1] ?? 2)
      return new Response(JSON.stringify({ code: 200, data: options.pool?.(page) ?? { total: rows.length,
        rows: rows.slice((page - 1) * size, page * size) } }))
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
    const hook = watchJob(remote.client, remote.ledger, { scope: 'new_claimable',
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
    const hook = watchJob(remote.client, remote.ledger, { scope: 'ids', script_ids: [11],
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
    const hook = watchJob(remote.client, remote.ledger, { scope: 'ids', script_ids: [11],
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
    const hook = watchJob(remote.client, remote.ledger, { scope: 'ids', script_ids: [11],
      start_at: new Date(now).toISOString(), end_at: new Date(now + 5000).toISOString(),
      idempotency_prefix: 'churn-window', authorization_basis: '用户明确要求本窗口认领 11' },
    { ...config, claimMaxItems: 1 })
    expect((await hook.done).status).toBe('completed')
    expect(remote.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  }, 10000)
})

it('rejects unsupported model method and scope JSON before any credential or provider work', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await()
  const credential = vi.fn(async () => { throw new Error('credentials must not be read') })
  ctx.provide('credentials', { resolve: credential })
  Object.assign(ctx, { plugin: () => undefined })
  try {
    apply(ctx, { ledgerRoot: join(root, 'schema-ledger') })
    for (const [name, args] of [['jubian_claim', { method: 'delete', script_id: 11 }],
      ['jubian_snatch', { scope: 'all', start_at: '2026-09-28T12:00:00.000Z', end_at: '2026-09-28T12:00:01.000Z',
        idempotency_prefix: 'invalid', authorization_basis: 'user authorized bounded claims' }]] as const) {
      const result = await ctx.tools.execute({ callId: ToolCallId(`invalid-${name}`), name,
        arguments: args, signal: new AbortController().signal })
      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text' && block.text.includes('invalid arguments'))).toBe(true)
    }
    expect(credential).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})

it('validates every deployment watcher limit before admission', () => {
  expect(resolveClaimWatchConfig({})).toMatchObject({ claimScanPageSize: 300, claimMaxItems: 100 })
  for (const config of [{ claimPollIntervalMs: 60001 }, { claimPollIntervalMs: 1000.5 }, { claimMaxWindowMs: 0 },
    { claimMaxLeadMs: 604800001 }, { claimScanPageSize: 1001 }, { claimScanPageLimit: 0 }, { claimMaxItems: 101 }]) {
    expect(() => resolveClaimWatchConfig(config)).toThrow('must be an integer')
  }
})

it.each([0, -1, 1.5])('rejects invalid screenplay identity %s before requesting the account', async (script_id) => {
  const remote = provider({ rows: () => [] })
  await expect(claimMethod(remote.client, remote.ledger, { method: 'inspect', script_id }, config)).rejects.toThrow('script_id')
  expect(remote.calls).toEqual([])
})

it.each([' ', 'x'.repeat(501)])('requires bounded explicit claim authorization', async (authorization_basis) => {
  const remote = provider({ rows: () => [] })
  await expect(claimMethod(remote.client, remote.ledger, { method: 'claim', script_id: 11,
    idempotency_key: 'invalid-authorization', authorization_basis }, config)).rejects.toThrow('authorization_basis')
  expect(remote.calls).toEqual([])
})

it.each([{}, [], { user: null }, { user: { userId: '91', userName: 'editor' } }, { user: { userId: 0, userName: 'editor' } },
  { user: { userId: 1.5, userName: 'editor' } }, { user: { userId: 91, userName: null } }, { user: { userId: 91, userName: ' ' } }])(
  'refuses provider account records that cannot identify the claimant', async (info) => {
    const remote = provider({ rows: () => [row(11, 1)], info })
    await expect(claimMethod(remote.client, remote.ledger, { method: 'inspect', script_id: 11 }, config)).rejects.toThrow('getInfo')
    expect(remote.calls.some(call => call.method === 'POST')).toBe(false)
  })

it.each(['member', 'producer_team', 'operator-one'])('recognizes the verified member role %s', async (role) => {
  const remote = provider({ role, rows: () => [] })
  expect(await claimMethod(remote.client, remote.ledger, { method: 'inspect', script_id: 11 }, config))
    .toMatchObject({ found: false, can_claim: null, script_name: null, status: null, role: 'member' })
})

it.each([null, 4, {}])('refuses unreadable provider role records', async (role) => {
  const remote = provider({ role, rows: () => [] })
  await expect(claimMethod(remote.client, remote.ledger, { method: 'inspect', script_id: 11 }, config)).rejects.toThrow()
})

it('reports an absent screenplay as unclaimable without storing or posting an attempt', async () => {
  const remote = provider({ rows: () => [] })
  expect(await claimMethod(remote.client, remote.ledger, { method: 'claim', script_id: 11,
    idempotency_key: 'absent', authorization_basis: 'user authorized11' }, config)).toMatchObject({ status: 'not_claimable', can_claim: null })
  expect(await remote.ledger.find('absent')).toBeUndefined()
})

it.each(['duplicate', 'changing-total', 'empty-page', 'page-limit'] as const)('fails closed on an incomplete %s pool scan', async (kind) => {
  const remote = provider({ rows: () => [], pool: page => page === 1
    ? { rows: [row(11, 1)], total: 2 }
    : { rows: kind === 'empty-page' ? [] : [row(kind === 'duplicate' ? 11 : 12, 1)], total: kind === 'changing-total' ? 3 : 2 } })
  await expect(claimMethod(remote.client, remote.ledger, { method: 'inspect', script_id: 11 },
    { ...config, claimScanPageLimit: kind === 'page-limit' ? 1 : 3 })).rejects.toThrow(/pool/)
  expect(remote.calls.some(call => call.method === 'POST')).toBe(false)
})

it('retains uncertainty when a POST receipt names another ID or subsequent readback fails', async () => {
  let failRead = false
  const remote = provider({ rows: () => { if (failRead) throw new Error('pool unavailable'); return [row(11, 1)] },
    claim: () => { failRead = true; return new Response(JSON.stringify({ code: 200, data: 12 })) } })
  expect(await claimMethod(remote.client, remote.ledger, { method: 'claim', script_id: 11,
    idempotency_key: 'wrong-receipt', authorization_basis: 'user authorized11' }, config))
    .toMatchObject({ status: 'unverified', failure: 'claim receipt did not confirm this ID', sent: true })
  expect(remote.calls.filter(call => call.method === 'POST')).toHaveLength(1)
})

it('refuses a reused ledger key that belongs to another operation', async () => {
  const remote = provider({ rows: () => [row(11, 1)] })
  await remote.ledger.begin({ idempotencyKey: 'other-op', method: 'asset_remove', scriptId: 11, requestSha256: 'body' })
  await expect(claimMethod(remote.client, remote.ledger, { method: 'claim', script_id: 11,
    idempotency_key: 'other-op', authorization_basis: 'user authorized11' }, config)).rejects.toThrow('different claim')
  expect(remote.calls.some(call => call.method === 'POST')).toBe(false)
})

it('does not duplicate a concurrently admitted claim with the same ledger key', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const remote = provider({ rows: () => [row(11, 1)], claim: async () => {
    entered.resolve(undefined)
    await release.promise
    return new Response(JSON.stringify({ code: 200, data: 11 }))
  } })
  const original = remote.ledger.find.bind(remote.ledger)
  const bothRead = Promise.withResolvers<undefined>()
  let reads = 0, arrived = 0
  vi.spyOn(remote.ledger, 'find').mockImplementation(async (key) => {
    if (reads++ < 2) {
      const record = await original(key)
      if (++arrived === 2) bothRead.resolve(undefined)
      await bothRead.promise
      return record
    }
    return await original(key)
  })
  const args = { method: 'claim', script_id: 11, idempotency_key: 'same-race', authorization_basis: 'user authorized11' } as const
  const first = claimMethod(remote.client, remote.ledger, args, config), second = claimMethod(remote.client, remote.ledger, args, config)
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => { reject(new Error('concurrent claims did not reach their owned barrier')) }, 10_000)
  })
  try {
    await Promise.race([entered.promise, expired])
    expect(await Promise.race([first, second, expired])).toMatchObject({ replayed: true, sent: false })
  } finally {
    clearTimeout(timeout)
    bothRead.resolve(undefined)
    release.resolve(undefined)
    await Promise.allSettled([first, second])
  }
  expect(remote.calls.filter(call => call.method === 'POST')).toHaveLength(1)
}, 30_000)

it('rechecks a racing ledger winner before any POST when it belongs to a different claim', async () => {
  const remote = provider({ rows: () => [row(11, 1)] })
  const original = remote.ledger.beginChecked.bind(remote.ledger)
  vi.spyOn(remote.ledger, 'beginChecked').mockImplementationOnce(async (key, prepare) => {
    await remote.ledger.begin({ idempotencyKey: key, method: 'asset_remove', scriptId: 11, requestSha256: bodyHash(undefined) })
    return await original(key, prepare)
  })
  await expect(claimMethod(remote.client, remote.ledger, { method: 'claim', script_id: 11,
    idempotency_key: 'other-winner', authorization_basis: 'user authorized11' }, config)).rejects.toThrow('different claim')
  expect(remote.calls.some(call => call.method === 'POST')).toBe(false)
})

it('records provider application failures independently from claimant readback', async () => {
  const remote = provider({ rows: () => [row(11, 1)], claim: () => new Response(JSON.stringify({ code: 403, msg: 'permission refused' })) })
  expect(await claimMethod(remote.client, remote.ledger, { method: 'claim', script_id: 11,
    idempotency_key: 'denied', authorization_basis: 'user authorized11' }, config)).toMatchObject({ status: 'unverified', failure: 'PERMISSION_DENIED' })
})

it('rejects noncanonical, elapsed, inverted, overly distant, and oversized watcher windows', () => {
  const now = new Date('2026-09-28T12:00:00.000Z')
  const args: ClaimWatchArgs = { scope: 'ids', script_ids: [11], start_at: now.toISOString(),
    end_at: '2026-09-28T12:00:10.000Z', idempotency_prefix: 'window', authorization_basis: 'user authorized11' }
  for (const fields of [{ start_at: 'invalid' }, { end_at: 'invalid' }, { start_at: '2026-09-28T12:00:00Z' },
    { end_at: '2026-09-28T12:00:10+00:00' }, { end_at: now.toISOString() },
    { start_at: '2026-09-28T12:00:11.000Z' }, { start_at: '2026-09-28T12:02:00.000Z', end_at: '2026-09-28T12:02:10.000Z' },
    { end_at: '2026-09-28T12:01:01.000Z' }]) expect(() => claimWatchArgs({ ...args, ...fields }, config, now)).toThrow('start_at/end_at')
  for (const script_ids of [[], [11, 11], [0], Array.from({ length: 11 }, (_, index) => index + 1)]) {
    expect(() => claimWatchArgs({ ...args, script_ids }, config, now)).toThrow('script_ids')
  }
  const { script_ids: _ids, ...noIds } = args
  expect(() => claimWatchArgs(noIds, config, now)).toThrow('script_ids')
  expect(() => claimWatchArgs({ ...args, scope: 'new_claimable' }, config, now)).toThrow('must be omitted')
  expect(() => claimWatchArgs({ ...noIds, scope: 'new_claimable' }, config, now)).not.toThrow()
})

it('stops at its item limit even when several new IDs become eligible in one scan', async () => {
  const now = new Date()
  let reads = 0, claimed = false
  const remote = provider({ rows: () => ++reads === 1 ? [] : [row(11, claimed ? 0 : 1, claimed ? { claimLeaderId: 91 } : {}), row(12, 1)],
    claim: () => { claimed = true; return new Response(JSON.stringify({ code: 200, data: 11 })) } })
  const hook = watchJob(remote.client, remote.ledger, { scope: 'new_claimable', start_at: now.toISOString(),
    end_at: new Date(now.getTime() + 60_000).toISOString(), idempotency_prefix: 'one-new', authorization_basis: 'user authorized new pool IDs' },
  { ...config, claimMaxItems: 1 }, now)
  expect(await hook.done).toMatchObject({ status: 'completed' })
  expect(remote.calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual(['/script/center/pool/claim/11'])
}, 30_000)

it.each(['ledger', 'account'] as const)('reports a non-cancellation %s failure without leaving a running watcher', async (kind) => {
  const now = new Date(), remote = provider({ rows: () => [row(11, 1)], ...kind === 'account' ? { info: {} } : {} })
  if (kind === 'ledger') vi.spyOn(remote.ledger, 'beginChecked').mockRejectedValueOnce(new Error('ledger unavailable'))
  const hook = watchJob(remote.client, remote.ledger, { scope: 'ids', script_ids: [11], start_at: now.toISOString(),
    end_at: new Date(now.getTime() + 60_000).toISOString(), idempotency_prefix: 'failed-job', authorization_basis: 'user authorized11' }, config, now)
  expect(await hook.done).toMatchObject({ status: 'failed', detail: kind === 'ledger' ? 'claim watcher failed' : 'CONTRACT_CHANGED' })
  expect(remote.calls.some(call => call.method === 'POST')).toBe(false)
})

it('rescans a target whose pool changes between eligibility and its one-shot claim without retaining a failed attempt', async () => {
  const now = new Date()
  let reads = 0, claimed = false
  const remote = provider({ rows: () => [], pool: (page) => {
    reads += 1
    const target = row(11, claimed ? 0 : 1, claimed ? { claimLeaderId: 91 } : {})
    return { rows: page === 1 ? [target, row(12, 0)] : [row(reads === 4 ? 11 : 13, 0)], total: 3 }
  }, claim: () => { claimed = true; return new Response(JSON.stringify({ code: 200, data: 11 })) } })
  const hook = watchJob(remote.client, remote.ledger, { scope: 'ids', script_ids: [11], start_at: now.toISOString(),
    end_at: new Date(now.getTime() + 60_000).toISOString(), idempotency_prefix: 'eligibility-churn', authorization_basis: 'user authorized11' }, config, now)
  const result = await hook.done
  expect(result.status).toBe('completed')
  if (!result.result) throw new Error('watch result unavailable')
  expect(JSON.parse(result.result)).toMatchObject({ attempted: [11], outcomes: [{ status: 'verified' }] })
  expect(remote.calls.filter(call => call.method === 'POST')).toHaveLength(1)
}, 30_000)

it('fails a watcher on malformed pool data without retrying it as pagination churn', async () => {
  const now = new Date()
  const remote = provider({ rows: () => [], pool: () => ({ rows: null, total: 1 }) })
  const hook = watchJob(remote.client, remote.ledger, { scope: 'ids', script_ids: [11], start_at: now.toISOString(),
    end_at: new Date(now.getTime() + 60_000).toISOString(), idempotency_prefix: 'malformed-pool',
    authorization_basis: 'user authorized11' }, config, now)
  expect(await hook.done).toMatchObject({ status: 'failed', detail: 'CONTRACT_CHANGED' })
  expect(remote.calls.map(call => call.path)).toEqual(['/script/center/pool/list?pageNum=1&pageSize=2'])
  expect(await remote.ledger.records()).toEqual([])
})

it('keeps a submitted claim uncertain when its initial ledger settlement fails', async () => {
  const remote = provider({ rows: () => [row(11, 1)] })
  const settle = vi.spyOn(remote.ledger, 'settle').mockRejectedValueOnce(new Error('ledger write unavailable'))
  expect(await claimMethod(remote.client, remote.ledger,
    { method: 'claim', script_id: 11, idempotency_key: 'settlement-failed', authorization_basis: 'user authorized11' }, config))
    .toMatchObject({ status: 'accepted_unverified', sent: true, failure: 'claim request failed' })
  expect(settle).toHaveBeenCalledTimes(2)
  expect((await remote.ledger.find('settlement-failed'))?.outcome).toBe('unknown')
  expect(remote.calls.filter(call => call.method === 'POST')).toHaveLength(1)
})
