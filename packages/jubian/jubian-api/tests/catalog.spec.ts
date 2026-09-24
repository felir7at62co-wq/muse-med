import { describe, expect, it } from 'vitest'
import { readEpisodes, readModels, readScript, readScriptList } from '../src/catalog.ts'

const IMAGE_MODEL = { id: 42, standardId: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN', unitPrice: 0.5, unit: '张',
  genTypes: [{ id: 7, type: 3 }],
  videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] }

describe('readModels', () => {
  it('passes catalogue rows through and rejects a non-array', () => {
    expect(readModels([IMAGE_MODEL])).toEqual([IMAGE_MODEL])
    expect(() => readModels({ nope: true })).toThrow()
  })
})

describe('readScript', () => {
  it('keeps the identity and name fields a project read needs', () => {
    expect(readScript({ id: 2708, name: '山海自有相逢处', productionType: 2, extra: 'ignored' }))
      .toEqual({ script_id: 2708, name: '山海自有相逢处', production_type: 2 })
  })

  it('reads the observed scriptName and keeps legacy name as a fallback', () => {
    expect(readScript({ id: 2708, scriptName: '山海自有相逢处' }))
      .toEqual({ script_id: 2708, name: '山海自有相逢处', production_type: null })
    expect(readScript({ id: 2708, name: 'legacy', scriptName: null }).name).toBe('legacy')
    expect(readScript({ id: 2708, name: 'legacy', scriptName: 'current' }).name).toBe('current')
  })

  it('rejects a payload without a usable identity', () => {
    expect(() => readScript({ name: 'x' })).toThrow()
    expect(() => readScript(null)).toThrow()
  })
})

describe('readEpisodes', () => {
  it('reads one envelope page into rows plus its total', () => {
    expect(readEpisodes({ total: 2, rows: [{ id: 1, name: '第1集' }, { id: 2, name: '第2集' }] }))
      .toEqual({ total: 2, rows: [{ episode_id: 1, name: '第1集' }, { episode_id: 2, name: '第2集' }] })
  })

  it('rejects a payload that is not a page', () => {
    expect(() => readEpisodes({ total: 2 })).toThrow()
  })
})

/** One script row as the pool endpoint answers it. */
const SCRIPT_ROW = {
  id: 885,
  scriptName: '墙缝里的眼',
  manuscriptName: '墙缝里的眼（终稿）',
  episodeCount: 62,
  status: 'pending_leader_claim',
  canClaim: 1,
  claimLeaderName: '杨礼楷',
  claimMemberName: null,
  originalNovelName: '墙缝里的眼',
  versionNo: 3,
}

/** The same row as this reader projects it. */
const SCRIPT_READ = {
  script_id: 885,
  script_name: '墙缝里的眼',
  manuscript_name: '墙缝里的眼（终稿）',
  episode_count: 62,
  status: 'pending_leader_claim',
  can_claim: true,
  claim_leader_name: '杨礼楷',
  claim_member_name: null,
}

/** The stable code a throwing call produced, or undefined when it did not throw. */
function codeOf(run: () => unknown): string | undefined {
  try { run() } catch (error) { return (error as { code?: string }).code }
  return undefined
}

describe('readScriptList', () => {
  it('reads the unwrapped list shape the pool endpoint returns', () => {
    // `{code, total, rows}` has no `data` wrapper; the transport hands this reader
    // the envelope's own keys when it finds none, so both spellings arrive here.
    expect(readScriptList({ code: 200, total: 1, rows: [SCRIPT_ROW] }))
      .toEqual({ total: 1, rows: [SCRIPT_READ] })
  })

  it('reads the same rows behind a data wrapper', () => {
    expect(readScriptList({ code: 200, data: { total: 1, rows: [SCRIPT_ROW] } }))
      .toEqual({ total: 1, rows: [SCRIPT_READ] })
  })

  it('projects only the promised fields', () => {
    expect(Object.keys(readScriptList({ code: 200, total: 1, rows: [SCRIPT_ROW] }).rows[0]!).sort())
      .toEqual(['can_claim', 'claim_leader_name', 'claim_member_name', 'episode_count', 'manuscript_name',
        'script_id', 'script_name', 'status'])
  })

  it('fails loud on a payload that is neither list shape', () => {
    expect(codeOf(() => readScriptList({ code: 200, msg: '操作成功' }))).toBe('CONTRACT_CHANGED')
    expect(codeOf(() => readScriptList({ code: 200, data: { total: 1 } }))).toBe('CONTRACT_CHANGED')
    expect(codeOf(() => readScriptList({ code: 200, total: 1, rows: 'nope' }))).toBe('CONTRACT_CHANGED')
    expect(codeOf(() => readScriptList(null))).toBe('CONTRACT_CHANGED')
    expect(codeOf(() => readScriptList([{ id: 1 }]))).toBe('CONTRACT_CHANGED')
  })

  it('requires the total a scan completeness claim rests on', () => {
    expect(codeOf(() => readScriptList({ code: 200, rows: [SCRIPT_ROW] }))).toBe('CONTRACT_CHANGED')
    expect(codeOf(() => readScriptList({ code: 200, total: '1', rows: [SCRIPT_ROW] }))).toBe('CONTRACT_CHANGED')
  })

  it('reads a row without an identity as a contract change rather than a nameless match', () => {
    expect(codeOf(() => readScriptList({ code: 200, total: 1, rows: [{ scriptName: '墙缝里的眼' }] })))
      .toBe('CONTRACT_CHANGED')
  })

  it('leaves every field the provider did not send null', () => {
    expect(readScriptList({ code: 200, total: 1, rows: [{ id: '412' }] })).toEqual({ total: 1, rows: [
      { script_id: 412, script_name: null, manuscript_name: null, episode_count: null, status: null,
        can_claim: null, claim_leader_name: null, claim_member_name: null },
    ] })
  })

  it('reads the flag spellings the provider uses for canClaim', () => {
    const flag = (value: unknown): unknown =>
      readScriptList({ code: 200, total: 1, rows: [{ id: 1, canClaim: value }] }).rows[0]?.can_claim
    expect(flag(true)).toBe(true)
    expect(flag(false)).toBe(false)
    expect(flag(1)).toBe(true)
    expect(flag(0)).toBe(false)
    expect(flag('1')).toBeNull()
    expect(flag(undefined)).toBeNull()
  })

  it('reads an empty page as an empty list, not as an error', () => {
    expect(readScriptList({ code: 200, total: 0, rows: [] })).toEqual({ total: 0, rows: [] })
  })
})
