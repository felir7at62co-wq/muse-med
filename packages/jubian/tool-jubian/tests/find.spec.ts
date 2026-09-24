import { describe, expect, it } from 'vitest'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import { MAX_MATCHES, MAX_SCAN_PAGES, findMethod } from '../src/find.ts'

/** The caller's own canvas projects, as `/aigc/script/list` lists them. */
const MINE = [
  { id: 2708, scriptName: '山海自有相逢处', manuscriptName: '山海自有相逢处（v3）',
    episodeCount: 60, status: 'in_production', scriptStyle: 0 },
  { id: 2711, scriptName: 'My   Drama', manuscriptName: '风起  第二季', episodeCount: 12, status: null,
    scriptStyle: 1 },
  { id: 2712, scriptName: '拼车惊魂', manuscriptName: '拼车惊魂', episodeCount: 48,
    status: 'produce_finished' },
]

/** The claimable pool, with the fields only that endpoint carries. */
const POOL = [
  { id: 885, scriptName: '墙缝里的眼', manuscriptName: '墙缝里的眼（终稿）', episodeCount: 62,
    status: 'pending_leader_claim', canClaim: 1, claimLeaderName: '杨礼楷', claimMemberName: null },
  { id: 884, scriptName: '天价猪圈', manuscriptName: '天价猪圈：开局继承千万原浆', episodeCount: 70,
    status: 'returned', canClaim: 0, claimLeaderName: null, claimMemberName: null },
  { id: 874, scriptName: '我靠哄睡成了侯府团宠', manuscriptName: '我靠哄睡成了侯府团宠', episodeCount: 55,
    status: 'claimed', canClaim: 0, claimLeaderName: '杨礼楷', claimMemberName: null },
]

/** Answer one list endpoint the way the provider does: `rows` per page plus the real `total`. */
function paged(rows: Record<string, unknown>[], shape: 'bare' | 'wrapped' = 'bare') {
  return (path: string): Response => {
    const num = Number(/pageNum=(\d+)/.exec(path)?.[1] ?? 1)
    const size = Number(/pageSize=(\d+)/.exec(path)?.[1] ?? 20)
    const body = { code: 200, total: rows.length, rows: rows.slice((num - 1) * size, num * size) }
    return new Response(JSON.stringify(shape === 'bare' ? body : { code: 200, data: body }), { status: 200 })
  }
}

/** A client whose one transport answers from `respond`, recording every path it asked for. */
function stubClient(respond: (path: string) => Response) {
  const calls: { method: string; path: string }[] = []
  const client = new JubianClient({ credential: async () => 'token',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url)
      calls.push({ method: String(init?.method), path })
      return respond(path)
    } })
  return { calls, client }
}

/** The stable code a throwing call produced, or undefined when it did not throw. */
async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try { await run() } catch (error) { return (error as { code?: string }).code }
  return undefined
}

/** One match row of a result, as the tool returns it. */
interface Match {
  script_id: number
  script_name: string | null
  manuscript_name: string | null
  episode_count: number | null
  status: string | null
  script_style?: number | null
  can_claim?: boolean | null
}

describe('findMethod over the caller\'s own projects', () => {
  it('matches a substring of either name field', async () => {
    const { client } = stubClient(paged(MINE))
    const byScriptName = await findMethod(client, { scope: 'mine', name: '山海自有' })
    expect(byScriptName.matches).toEqual([
      { script_id: 2708, script_name: '山海自有相逢处', manuscript_name: '山海自有相逢处（v3）',
        episode_count: 60, status: 'in_production', script_style: 0 },
    ])

    const byManuscript = await findMethod(client, { scope: 'mine', name: 'v3）' })
    expect((byManuscript.matches as Match[]).map(match => match.script_id)).toEqual([2708])
  })

  it('trims and collapses whitespace and ignores case on both fields', async () => {
    const { client } = stubClient(paged(MINE))
    const spaced = await findMethod(client, { scope: 'mine', name: '  my   drama  ' })
    expect((spaced.matches as Match[]).map(match => match.script_id)).toEqual([2711])

    const manuscript = await findMethod(client, { scope: 'mine', name: '风起 第二季' })
    expect((manuscript.matches as Match[]).map(match => match.script_id)).toEqual([2711])

    const upper = await findMethod(client, { scope: 'mine', name: 'MY DRAMA' })
    expect((upper.matches as Match[]).map(match => match.script_id)).toEqual([2711])
  })

  it('matches a stored-name prefix but not a reordering, a pinyin spelling or an alias', async () => {
    const { client } = stubClient(paged(MINE))
    // Substring matching deliberately includes a prefix of the stored name.
    const prefix = await findMethod(client, { scope: 'mine', name: '山海自有相逢' })
    expect(prefix.matches).toMatchObject([{ script_id: 2708 }])
    const nearMiss = await findMethod(client, { scope: 'mine', name: '山海相逢' })
    expect(nearMiss.matches).toEqual([])
    expect(nearMiss.total).toBe(3)
    expect((await findMethod(client, { scope: 'mine', name: 'shanhai' })).matches).toEqual([])
    expect((await findMethod(client, { scope: 'mine', name: '山与海' })).matches).toEqual([])
  })

  it('carries no pool-only field on a project the caller owns', async () => {
    const { client } = stubClient(paged(MINE))
    const result = await findMethod(client, { scope: 'mine', name: '拼车' })
    expect(Object.keys((result.matches as Match[])[0]!).sort()).toEqual(
      ['episode_count', 'manuscript_name', 'script_id', 'script_name', 'script_style', 'status'])
  })

  it('returns script_style in every match', async () => {
    const { client } = stubClient(paged(MINE))
    const stated = await findMethod(client, { scope: 'mine', name: '山海' })
    expect(stated.matches).toEqual([
      { script_id: 2708, script_name: '山海自有相逢处', manuscript_name: '山海自有相逢处（v3）',
        episode_count: 60, status: 'in_production', script_style: 0 },
    ])

    const threeD = await findMethod(client, { scope: 'mine', name: 'drama' })
    expect(threeD.matches).toMatchObject([{ script_id: 2711, script_style: 1 }])

    // A row the provider sent no style for reports null instead of a guessed one.
    const absent = await findMethod(client, { scope: 'mine', name: '拼车' })
    expect(absent.matches).toMatchObject([{ script_id: 2712, script_style: null }])
  })
})

describe('findMethod over the 漫剧 project lists', () => {
  it('forwards production_type and share_target_type as productionType and shareTargetType', async () => {
    const { calls, client } = stubClient(paged(MINE))
    await findMethod(client, { scope: 'mine', production_type: 0, share_target_type: 1 })
    // Captured from the console's own 漫剧视频 request; the values are the
    // provider's codes and this tool interprets neither of them.
    expect(calls).toEqual([{ method: 'GET',
      path: 'https://web.jubianai.net/prod-api/aigc/script/list'
        + '?pageNum=1&pageSize=20&productionType=0&shareTargetType=1' }])
  })

  it('forwards each parameter on its own and leaves an absent one out of the query', async () => {
    const production = stubClient(paged(MINE))
    await findMethod(production.client, { scope: 'mine', production_type: 0 })
    expect(production.calls[0]!.path).toBe('https://web.jubianai.net/prod-api/aigc/script/list'
      + '?pageNum=1&pageSize=20&productionType=0')

    const share = stubClient(paged(MINE))
    await findMethod(share.client, { scope: 'mine', share_target_type: 1 })
    expect(share.calls[0]!.path).toBe('https://web.jubianai.net/prod-api/aigc/script/list'
      + '?pageNum=1&pageSize=20&shareTargetType=1')

    const plain = stubClient(paged(MINE))
    await findMethod(plain.client, { scope: 'mine' })
    expect(plain.calls[0]!.path).toBe('https://web.jubianai.net/prod-api/aigc/script/list'
      + '?pageNum=1&pageSize=20')
  })

  it('repeats both parameters on every page of a scan', async () => {
    const { calls, client } = stubClient(paged(MINE))
    const result = await findMethod(client, { scope: 'mine', name: '不存在', page_size: 2,
      production_type: 0, share_target_type: 1 })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.path).toContain('pageNum=1&pageSize=2&productionType=0&shareTargetType=1')
    expect(calls[1]!.path).toContain('pageNum=2&pageSize=2&productionType=0&shareTargetType=1')
    expect(result).toMatchObject({ total: 3, scanned_pages: 2, complete: true, returned: 0 })
  })

  it('refuses both parameters on the claimable pool instead of ignoring them', async () => {
    const { calls, client } = stubClient(paged(POOL))
    expect(await codeOf(() => findMethod(client, { scope: 'pool', production_type: 0 })))
      .toBe('INVALID_ARGUMENT')
    expect(await codeOf(() => findMethod(client, { scope: 'pool', share_target_type: 1 })))
      .toBe('INVALID_ARGUMENT')
    const chinese = /[\u4e00-\u9fff]/
    await expect(findMethod(client, { scope: 'pool', production_type: 0 })).rejects.toThrow(chinese)
    await expect(findMethod(client, { scope: 'pool', share_target_type: 1 })).rejects.toThrow(chinese)
    expect(calls).toEqual([])
  })

  it('refuses a value that is not an integer, before any request leaves', async () => {
    const { calls, client } = stubClient(paged(MINE))
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      expect(await codeOf(() => findMethod(client, { scope: 'mine', production_type: value })))
        .toBe('INVALID_ARGUMENT')
      expect(await codeOf(() => findMethod(client, { scope: 'mine', share_target_type: value })))
        .toBe('INVALID_ARGUMENT')
    }
    expect(calls).toEqual([])
  })
})

describe('findMethod over the claimable pool', () => {
  it('matches on either name field and carries the pool-only fields', async () => {
    const { client } = stubClient(paged(POOL))
    const byName = await findMethod(client, { scope: 'pool', name: '墙缝' })
    expect(byName.matches).toEqual([
      { script_id: 885, script_name: '墙缝里的眼', manuscript_name: '墙缝里的眼（终稿）', episode_count: 62,
        status: 'pending_leader_claim', can_claim: true, claim_leader_name: '杨礼楷', claim_member_name: null },
    ])

    const byManuscript = await findMethod(client, { scope: 'pool', name: '千万原浆' })
    expect((byManuscript.matches as Match[]).map(match => match.script_id)).toEqual([884])
  })

  it('forwards status on every page of a pool scan', async () => {
    const { calls, client } = stubClient(paged(POOL))
    const result = await findMethod(client, { scope: 'pool', name: '我靠', status: 'claimed', page_size: 2 })
    expect(result.matches).toHaveLength(1)
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.method).toBe('GET')
      expect(call.path).toContain('/script/center/pool/list')
      expect(call.path).toContain('status=claimed')
    }
  })

  it('refuses status on the caller\'s own projects instead of ignoring it', async () => {
    const { calls, client } = stubClient(paged(MINE))
    expect(await codeOf(() => findMethod(client, { scope: 'mine', name: '拼车', status: 'claimed' })))
      .toBe('INVALID_ARGUMENT')
    expect(calls).toEqual([])
  })

  it('scans the caller\'s own canvas projects at the pool\'s own path', async () => {
    const { calls, client } = stubClient(paged(MINE))
    await findMethod(client, { scope: 'mine', name: '拼车' })
    expect(calls[0]!.path).toBe('https://web.jubianai.net/prod-api/aigc/script/list?pageNum=1&pageSize=20')
  })
})

describe('findMethod pagination', () => {
  it('reads every page the total needs and says so', async () => {
    const { calls, client } = stubClient(paged(POOL))
    const result = await findMethod(client, { scope: 'pool', name: '拼车', page_size: 2 })
    // The name matches nothing, so every page is read to be sure the answer is empty.
    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call.path).toContain('pageSize=2')
    expect(result).toMatchObject({ scope: 'pool', total: 3, scanned_pages: 2, complete: true, returned: 0 })
  })

  it('bounds one request by page_size without bounding the scan', async () => {
    const { calls, client } = stubClient(paged(POOL))
    const result = await findMethod(client, { scope: 'pool', name: '墙缝', page_size: 1 })
    expect(calls).toHaveLength(3)
    expect(calls[0]!.path).toContain('pageSize=1')
    expect(result).toMatchObject({ scanned_pages: 3, complete: true, returned: 1 })
  })

  it('stops at the page bound and reports the scan incomplete', async () => {
    const rows = Array.from({ length: 1_000_000 }, (_unused, index) => ({ id: index + 1, scriptName: '拼车惊魂' }))
    const { calls, client } = stubClient(paged(rows))
    const result = await findMethod(client, { scope: 'pool', name: '不存在' })
    expect(calls).toHaveLength(MAX_SCAN_PAGES)
    expect(result).toMatchObject({ scanned_pages: MAX_SCAN_PAGES, complete: false,
      scan_page_limit: MAX_SCAN_PAGES, returned: 0 })
    expect(result.total).toBe(1_000_000)
  })

  it('starts at page_num and counts the rows it skipped', async () => {
    const { calls, client } = stubClient(paged(MINE))
    const result = await findMethod(client, { scope: 'mine', name: '拼车', page_num: 2, page_size: 2 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toContain('pageNum=2')
    expect(result).toMatchObject({ scanned_pages: 1, complete: true, returned: 1 })
  })

  it('refuses page arguments outside the provider\'s own range', async () => {
    const { calls, client } = stubClient(paged(MINE))
    expect(await codeOf(() => findMethod(client, { scope: 'mine', page_num: 0 }))).toBe('INVALID_ARGUMENT')
    expect(await codeOf(() => findMethod(client, { scope: 'mine', page_size: 1001 }))).toBe('INVALID_ARGUMENT')
    expect(await codeOf(() => findMethod(client, { scope: 'mine', page_size: 1.5 }))).toBe('INVALID_ARGUMENT')
    expect(calls).toEqual([])
  })
})

describe('findMethod payload and argument handling', () => {
  it('reads the unwrapped pool list and the data-wrapped project list', async () => {
    const pool = stubClient(paged(POOL, 'bare'))
    const mine = stubClient(paged(MINE, 'wrapped'))
    expect((await findMethod(pool.client, { scope: 'pool', name: '墙缝' })).returned).toBe(1)
    expect((await findMethod(mine.client, { scope: 'mine', name: '山海' })).returned).toBe(1)
  })

  it('fails loud on a payload that is neither list shape instead of reporting no match', async () => {
    const { client } = stubClient(() =>
      new Response(JSON.stringify({ code: 200, msg: '操作成功' }), { status: 200 }))
    expect(await codeOf(() => findMethod(client, { scope: 'mine', name: '山海' }))).toBe('CONTRACT_CHANGED')
  })

  it('lists the first page when no name is given', async () => {
    const { calls, client } = stubClient(paged(POOL))
    const result = await findMethod(client, { scope: 'pool', page_size: 2 })
    expect(calls).toHaveLength(1)
    expect(result).toMatchObject({ scope: 'pool', name: null, total: 3, scanned_pages: 1, complete: false,
      returned: 2, truncated: false })
    expect((result.matches as Match[]).map(match => match.script_id)).toEqual([885, 884])
    expect((result.matches as Match[])[0]).toMatchObject({ can_claim: true, claim_leader_name: '杨礼楷' })
  })

  it('flags a match list cut by the output cap', async () => {
    const rows = Array.from({ length: MAX_MATCHES + 5 }, (_unused, index) => ({ id: index + 1, scriptName: '拼车惊魂' }))
    const { client } = stubClient(paged(rows))
    const result = await findMethod(client, { scope: 'mine', name: '拼车', page_size: 1000 })
    expect(result).toMatchObject({ total: MAX_MATCHES + 5, complete: true, returned: MAX_MATCHES, truncated: true })
    expect(result.matches).toHaveLength(MAX_MATCHES)

    const few = await findMethod(client, { scope: 'mine', name: '拼车', page_size: 2 })
    expect(few).toMatchObject({ truncated: false })
  })

  it('requires a scope it can scan and a name it can match on', async () => {
    const { calls, client } = stubClient(paged(MINE))
    expect(await codeOf(() => findMethod(client, {}))).toBe('INVALID_ARGUMENT')
    expect(await codeOf(() => findMethod(client, { scope: 'both' }))).toBe('INVALID_ARGUMENT')
    expect(await codeOf(() => findMethod(client, { scope: 'mine', name: '   ' }))).toBe('INVALID_ARGUMENT')
    expect(calls).toEqual([])
  })
})
