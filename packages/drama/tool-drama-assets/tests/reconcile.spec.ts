/**
 * The comparison, the evidence file it writes, and the dispositions it inherits.
 *
 * The cases here are the pipeline's own: what the manifest and the remote project
 * each say, and which of the two disagreements releases a paid asset creation.
 */

import { readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildReport, chinaStamp, deriveVerdicts, disposeAsset, evidencePath, readEvidence,
  reconcileProject, resolveProjectDir } from '../src/reconcile.ts'
import type { ReconcileReport } from '../src/types.ts'
import { cleanup, manifestDocument, stubTransport, tempProject, writeInto } from './harness.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (dir) => { await cleanup(dir) }))
})

/** One project tracked for cleanup, with the standard manifest unless a document is given. */
async function project(document: Record<string, unknown> = manifestDocument()): Promise<string> {
  const dir = await tempProject(document)
  temporary.push(dir)
  return dir
}

/** One project with no manifest at all, tracked for cleanup. */
async function projectWithoutManifest(): Promise<string> {
  const dir = await tempProject()
  temporary.push(dir)
  return dir
}

/** Read one project's evidence file as the pipeline's own report script would. */
async function evidence(projectDir: string): Promise<ReconcileReport> {
  return JSON.parse(await readFile(evidencePath(projectDir), 'utf8')) as ReconcileReport
}

/** The alive asset rows a remote project holds for the manifest's three ids. */
const ALIVE = [
  { id: 125204, delFlag: '0', assetName: '陆沉舟', assetType: 1 },
  { id: 125300, delFlag: '0', assetName: '公文箱', assetType: 3 },
  { id: 125400, delFlag: '0', assetName: '林晚', assetType: 1 },
]

/** The used-and-active material rows for the same three assets. */
const USED = [
  { id: 124527, assetId: 125204, assetName: '陆沉舟', assetType: 1, isUsed: 1, hsAssetStatus: 'Active' },
  { id: 124528, assetId: 125300, assetName: '公文箱', assetType: 3, isUsed: 1, hsAssetStatus: 'Active' },
  { id: 124529, assetId: 125400, assetName: '林晚', assetType: 1, isUsed: 1, hsAssetStatus: 'Active' },
]

describe('chinaStamp', () => {
  it('stamps an instant as ISO seconds with the +08:00 offset the pipeline reads', () => {
    // 2026-09-20T07:12:20Z is 15:12:20 in China Standard Time.
    expect(chinaStamp(new Date('2026-09-20T07:12:20.000Z'))).toBe('2026-09-20T15:12:20+08:00')
  })

  it('defaults to the current instant', () => {
    expect(chinaStamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
  })
})

describe('resolveProjectDir', () => {
  it('resolves a named directory', () => {
    expect(resolveProjectDir('C:/drama/ep05')).toBe(resolveProjectDir('C:/drama/ep05'))
    expect(resolveProjectDir('  C:/drama/ep05  ')).toContain('ep05')
  })

  it('refuses a missing or blank directory', () => {
    expect(() => resolveProjectDir(undefined)).toThrow('project_dir 必填')
    expect(() => resolveProjectDir('   ')).toThrow('project_dir 必填')
  })
})

describe('reconcileProject', () => {
  it('matches both sides, marks everything registered, and reports nothing to dispose', async () => {
    const projectDir = await project()
    const { client, calls, methods } = stubTransport(ALIVE, USED)
    const report = await reconcileProject(client, projectDir, new Date('2026-09-20T07:12:20.000Z'))

    expect(report.script_id).toBe(2708)
    expect(report.ran_at).toBe('2026-09-20T15:12:20+08:00')
    expect(report.source).toEqual({ asset_list_rows: 3, material_list_rows: 3, remote_alive: 3, remote_used: 3 })
    expect(report.manifest).toEqual({ items: 2, lead_readonly_records: 1, asset_ids: 3 })
    expect(report.matched).toBe(3)
    expect(report.unregistered).toEqual([])
    expect(report.dangling).toEqual([])
    expect(report.blocking).toEqual([])
    expect(report.ignored_without_note).toEqual([])
    expect(report.ready).toBe(true)
    expect(report.cross_project_note).toBe('')
    expect(report.policy).toEqual({
      image_channel: 'KU_AI',
      image_unit_price_cny: 0.12,
      max_attempts_per_asset: 3,
      worst_case_cny_per_asset: 0.36,
      cross_project_reuse: '手动：先跑 jubian-asset-library 技能检索，结论写进本文件的 cross_project_note',
    })

    // Only reads, and only the two list endpoints.
    expect(methods).toEqual(['GET', 'GET'])
    expect(calls[0]).toContain('/aigc/asset/list?scriptId=2708&pageNum=1&pageSize=1000')
    expect(calls[1]).toContain('/aigc/material/list?scriptId=2708&pageNum=1&pageSize=1000')

    // The file the host gate reads is the same document, two-space indented with one trailing newline.
    const text = await readFile(evidencePath(projectDir), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual(report)
  })

  it('lists a used asset the manifest does not record and refuses the paid generation', async () => {
    // The manifest records none of the three used assets, so all three are unregistered.
    const projectDir = await project(manifestDocument({ items: [], lead_readonly_records: [] }))
    const { client } = stubTransport([
      ...ALIVE,
      { id: 83840, delFlag: '0', assetName: '陆沉舟｜深巧克力年轻高定西装', assetType: 1,
        url: 'https://example.invalid/asset.jpg', createTime: '2026-08-28 18:19:07' },
    ], [
      ...USED,
      { id: 81426, assetId: 83840, assetName: '陆沉舟｜深巧克力年轻高定西装', assetType: 1, isUsed: 1,
        hsAssetStatus: 'Active', assetUrl: 'https://example.invalid/material.jpg',
        createTime: '2026-08-28 18:19:08' },
    ])
    const report = await reconcileProject(client, projectDir)

    expect(report.matched).toBe(0)
    // Ascending asset id order: 83840 sorts before the 125xxx range.
    expect(report.unregistered).toEqual([
      // The material row answers every field the asset row also carries.
      { asset_id: 83840, material_id: 81426, name: '陆沉舟｜深巧克力年轻高定西装', asset_type: 1, is_used: 1,
        hs_asset_status: 'Active', url: 'https://example.invalid/material.jpg',
        create_time: '2026-08-28 18:19:08' },
      { asset_id: 125204, material_id: 124527, name: '陆沉舟', asset_type: 1, is_used: 1,
        hs_asset_status: 'Active', url: null, create_time: null },
      { asset_id: 125300, material_id: 124528, name: '公文箱', asset_type: 3, is_used: 1,
        hs_asset_status: 'Active', url: null, create_time: null },
      { asset_id: 125400, material_id: 124529, name: '林晚', asset_type: 1, is_used: 1,
        hs_asset_status: 'Active', url: null, create_time: null },
    ])
    expect(report.disposition['83840']).toEqual({ status: 'pending', note: '' })
    expect(report.blocking).toEqual([83840, 125204, 125300, 125400])
    expect(report.ready).toBe(false)
  })
  it('reports only the used rows the manifest does not record', async () => {
    // The ledger's own manifest records one of the three used assets.
    const projectDir = await project(manifestDocument({ items: [
      { stable_id: 'char_lu', name: '陆沉舟', jubian_asset_id: 125204 },
    ], lead_readonly_records: [] }))
    const { client } = stubTransport(ALIVE, USED)
    const report = await reconcileProject(client, projectDir)

    expect(report.matched).toBe(1)
    expect(report.unregistered.map(item => item.asset_id)).toEqual([125300, 125400])
    expect(report.blocking).toEqual([125300, 125400])
  })

  it('keeps a removed asset out of the alive side and off the unregistered list', async () => {
    const projectDir = await project(manifestDocument({ items: [
      { stable_id: 'char_lu', name: '陆沉舟', jubian_asset_id: 125204 },
    ], lead_readonly_records: [] }))
    const { client } = stubTransport([
      { id: 125204, delFlag: '0', assetName: '陆沉舟', assetType: 1 },
      { id: 90001, delFlag: '1', assetName: '已删资产', assetType: 1 },
    ], [
      { id: 124527, assetId: 125204, assetName: '陆沉舟', isUsed: 1, hsAssetStatus: 'Active' },
      // Used, but the asset was removed: the pipeline's rule counts only alive rows.
      { id: 90002, assetId: 90001, assetName: '已删资产', isUsed: 1, hsAssetStatus: 'Active' },
    ])
    const report = await reconcileProject(client, projectDir)

    expect(report.source).toEqual({ asset_list_rows: 2, material_list_rows: 2, remote_alive: 1, remote_used: 1 })
    // The removed asset is used but not alive, and the comparison counts only alive
    // rows: nothing on this project is a used-and-alive asset the manifest misses.
    expect(report.unregistered).toEqual([])
    expect(report.matched).toBe(1)
    expect(report.ready).toBe(true)
  })

  it('ignores a material that is not both used and Active', async () => {
    const projectDir = await project(manifestDocument({ items: [], lead_readonly_records: [] }))
    const { client } = stubTransport([
      { id: 1, delFlag: '0', assetName: 'A' },
      { id: 2, delFlag: '0', assetName: 'B' },
      { id: 3, delFlag: '0', assetName: 'C' },
      { id: 4, delFlag: '0', assetName: 'D' },
    ], [
      { id: 11, assetId: 1, isUsed: 0, hsAssetStatus: 'Active' },
      { id: 12, assetId: 2, isUsed: 1, hsAssetStatus: 'Pending' },
      { id: 13, assetId: 3, isUsed: 1 },
      { id: 14, assetId: 4, isUsed: 1, hsAssetStatus: 'Active' },
      { id: 15, assetId: null, isUsed: 1, hsAssetStatus: 'Active' },
    ])
    const report = await reconcileProject(client, projectDir)

    expect(report.source.remote_used).toBe(1)
    expect(report.unregistered.map(item => item.asset_id)).toEqual([4])
    expect(report.matched).toBe(0)
  })

  it('takes the first used material per asset and the material fields before the asset fields', async () => {
    const projectDir = await project(manifestDocument({ items: [], lead_readonly_records: [] }))
    const { client } = stubTransport([
      // The asset row carries no name, no type and no url, so the material row answers all three.
      { id: 83840, delFlag: '0' },
    ], [
      { id: 81426, assetId: 83840, assetName: '第一行', assetType: 2, isUsed: 1, hsAssetStatus: 'Active',
        assetUrl: 'https://example.invalid/first.jpg', createTime: '2026-08-28 18:19:07' },
      { id: 81427, assetId: 83840, assetName: '第二行', assetType: 1, isUsed: 1, hsAssetStatus: 'Active' },
    ])
    const report = await reconcileProject(client, projectDir)

    expect(report.unregistered).toEqual([{
      asset_id: 83840, material_id: 81426, name: '第一行', asset_type: 2, is_used: 1,
      hs_asset_status: 'Active', url: 'https://example.invalid/first.jpg', create_time: '2026-08-28 18:19:07',
    }])
  })

  it('falls back to the alive asset row for every field the material row omits', async () => {
    const projectDir = await project(manifestDocument({ items: [], lead_readonly_records: [] }))
    const { client } = stubTransport([
      { id: 83840, delFlag: '0', assetName: '资产行名字', assetType: 3, url: 'https://example.invalid/asset.jpg',
        createTime: '2026-08-28 10:00:00' },
    ], [
      { id: 81426, assetId: 83840, isUsed: 1, hsAssetStatus: 'Active' },
    ])
    const report = await reconcileProject(client, projectDir)

    expect(report.unregistered[0]).toEqual({
      asset_id: 83840, material_id: 81426, name: '资产行名字', asset_type: 3, is_used: 1,
      hs_asset_status: 'Active', url: 'https://example.invalid/asset.jpg', create_time: '2026-08-28 10:00:00',
    })
  })

  it('spells an absent provider field as null in the evidence file', async () => {
    const projectDir = await project(manifestDocument({ items: [], lead_readonly_records: [] }))
    const { client } = stubTransport([{ id: 83840, delFlag: '0' }],
      [{ id: 81426, assetId: 83840, isUsed: 1, hsAssetStatus: 'Active' }])
    const report = await reconcileProject(client, projectDir)

    // The file's own spelling is null: the pipeline's Python report prints the same
    // value for a field neither the material row nor the asset row carried.
    expect(report.unregistered[0]).toEqual({
      asset_id: 83840, material_id: 81426, name: null, asset_type: null, is_used: 1,
      hs_asset_status: 'Active', url: null, create_time: null,
    })
    const written = await evidence(projectDir)
    expect(written.unregistered[0]?.name).toBeNull()
    expect(written.unregistered[0]?.create_time).toBeNull()
  })

  it('reads under either asset-name spelling and keeps absent text absent', async () => {
    const projectDir = await project(manifestDocument({ items: [], lead_readonly_records: [] }))
    const { client } = stubTransport([
      { id: 1, delFlag: '0', assetName: '   ' },
      { id: 2, delFlag: '0', assetName: '资产名' },
      { id: 3, delFlag: '0', assetName: 'x', assetType: 2 },
    ], [
      { id: 11, assetId: 1, name: '材质 name 拼写', isUsed: 1, hsAssetStatus: 'Active' },
      { id: 12, assetId: 2, name: '材质 name 拼写', assetType: 3, isUsed: 1, hsAssetStatus: 'Active' },
      { id: 13, assetId: 3, assetName: '材质 assetName 拼写', isUsed: 1, hsAssetStatus: 'Active' },
    ])
    const report = await reconcileProject(client, projectDir)

    // The blank assetName is not text, so the material's `name` spelling answers.
    expect(report.unregistered[0]).toMatchObject({ asset_id: 1, name: '材质 name 拼写' })
    // A material `name` wins over the material's own `assetName`-shaped field.
    expect(report.unregistered[1]).toMatchObject({ asset_id: 2, name: '材质 name 拼写', asset_type: 3 })
    // The material falls back to the asset row and keeps the asset's type.
    expect(report.unregistered[2]).toMatchObject({ asset_id: 3, name: '材质 assetName 拼写', asset_type: 2 })
  })

  it('reports a manifest record the remote project does not hold, with a null name and stable id', async () => {
    const projectDir = await project(manifestDocument({ items: [
      { stable_id: 'char_lu', name: '陆沉舟', jubian_asset_id: 125204 },
      { stable_id: 'prop_box', name: '公文箱', jubian_asset_id: 125300 },
      { stable_id: 'char_gone', jubian_asset_id: 4242 },
      { name: '无 stable_id', jubian_asset_id: 4243 },
      { stable_id: 'no_id', name: '没有 asset id' },
      { stable_id: 'string_id', name: '字符串 id', jubian_asset_id: '125204' },
    ], lead_readonly_records: [] }))
    const { client } = stubTransport(ALIVE, USED)
    const report = await reconcileProject(client, projectDir)

    // 125204 and 125300 are alive and the two unheld ids dangle; the string id is a
    // manifest defect this comparison counts as declared and then reports as dangling,
    // because a string id is not the asset id the remote project holds under it.
    expect(report.manifest.asset_ids).toBe(4)
    expect(report.dangling).toEqual([
      { stable_id: 'char_gone', jubian_asset_id: 4242, name: null,
        why: '清单里有这条记录，远端 asset/list 里没有它（可能在别的 scriptId 或已被删）' },
      { stable_id: null, jubian_asset_id: 4243, name: '无 stable_id',
        why: '清单里有这条记录，远端 asset/list 里没有它（可能在别的 scriptId 或已被删）' },
    ])
    expect(report.source.remote_alive).toBe(3)
    // Dangling records do not block by themselves, but 83840 is used and unrecorded,
    // so the verdict still refuses a paid generation.
    expect(report.ready).toBe(false)
  })

  it('sorts the unregistered list by asset id', async () => {
    const projectDir = await project(manifestDocument({ items: [], lead_readonly_records: [] }))
    const { client } = stubTransport([
      { id: 900, delFlag: '0' }, { id: 100, delFlag: '0' }, { id: 500, delFlag: '0' },
    ], [
      { id: 1, assetId: 900, isUsed: 1, hsAssetStatus: 'Active' },
      { id: 2, assetId: 100, isUsed: 1, hsAssetStatus: 'Active' },
      { id: 3, assetId: 500, isUsed: 1, hsAssetStatus: 'Active' },
    ])
    const report = await reconcileProject(client, projectDir)
    expect(report.unregistered.map(item => item.asset_id)).toEqual([100, 500, 900])
    expect(report.disposition).toEqual({
      100: { status: 'pending', note: '' },
      500: { status: 'pending', note: '' },
      900: { status: 'pending', note: '' },
    })
  })

  it('inherits the previous dispositions, keeps their notes, and auto-registers what the manifest now holds', async () => {
    const projectDir = await project()
    const { client } = stubTransport([...ALIVE,
      { id: 7001, delFlag: '0' }, { id: 7002, delFlag: '0' }, { id: 7003, delFlag: '0' }], [...USED,
      { id: 71, assetId: 7001, isUsed: 1, hsAssetStatus: 'Active' },
      { id: 72, assetId: 7002, isUsed: 1, hsAssetStatus: 'Active' },
      { id: 73, assetId: 7003, isUsed: 1, hsAssetStatus: 'Active' }])
    await writeInto(evidencePath(projectDir), JSON.stringify({
      disposition: {
        7001: { status: 'ignored', note: '别的剧的备选' },
        7002: { status: 'registered', note: '上一轮的备注' },
        125204: { status: 'ignored', note: '已在清单里，这轮应被自动改正' },
      },
      cross_project_note: '跨项目库里没有同款西装',
    }))

    const report = await reconcileProject(client, projectDir)

    expect(report.disposition['7001']).toEqual({ status: 'ignored', note: '别的剧的备选' })
    expect(report.disposition['7002']).toEqual({ status: 'registered', note: '上一轮的备注' })
    // 125204 is in the manifest, so the entry becomes registered and keeps its note.
    expect(report.disposition['125204']).toEqual({ status: 'registered', note: '已在清单里，这轮应被自动改正' })
    expect(report.disposition['7003']).toEqual({ status: 'pending', note: '' })
    expect(report.blocking).toEqual([7003])
    expect(report.ignored_without_note).toEqual([])
    expect(report.ready).toBe(false)
    expect(report.cross_project_note).toBe('跨项目库里没有同款西装')
  })

  it('flags an ignored disposition that carries no note', async () => {
    const projectDir = await project(manifestDocument({ items: [], lead_readonly_records: [] }))
    const { client } = stubTransport([{ id: 7001, delFlag: '0' }],
      [{ id: 71, assetId: 7001, isUsed: 1, hsAssetStatus: 'Active' }])
    await writeInto(evidencePath(projectDir), JSON.stringify({
      disposition: { 7001: { status: 'ignored', note: '   ' } },
    }))
    const report = await reconcileProject(client, projectDir)

    expect(report.blocking).toEqual([])
    expect(report.ignored_without_note).toEqual([7001])
    expect(report.ready).toBe(false)
  })

  it('follows every asset page a project spans', async () => {
    const projectDir = await project(manifestDocument({ items: [], lead_readonly_records: [] }))
    // One row past a full page, so the walk must ask for a second page.
    const assets = Array.from({ length: 1001 }, (_unused, index) => ({ id: index + 1, delFlag: '0' }))
    const { client, calls } = stubTransport(assets, [])
    const report = await reconcileProject(client, projectDir)

    expect(calls.filter(path => path.includes('/aigc/asset/list'))).toHaveLength(2)
    expect(report.source.asset_list_rows).toBe(1001)
    expect(report.source.remote_alive).toBe(1001)
  })

  it('stops when the provider declares fewer rows than the page it answered with', async () => {
    const projectDir = await project(manifestDocument({ items: [], lead_readonly_records: [] }))
    const assets = Array.from({ length: 1001 }, (_unused, index) => ({ id: index + 1, delFlag: '0' }))
    const { client, calls } = stubTransport(assets, [], { assetTotal: 1 })
    const report = await reconcileProject(client, projectDir)

    expect(calls.filter(path => path.includes('/aigc/asset/list'))).toHaveLength(1)
    expect(report.source.asset_list_rows).toBe(1000)
  })

  it('fails the call on a page whose rows the provider list reader rejects', async () => {
    // The reader owns what a page is, and a page it refuses fails the comparison:
    // a project whose asset list cannot be read is not a project with no assets.
    for (const rows of [{}, 'rows']) {
      const projectDir = await project(manifestDocument({ items: [], lead_readonly_records: [] }))
      const { client } = stubTransport([], [], { assetRows: rows })
      await expect(reconcileProject(client, projectDir)).rejects.toThrow('did not match the expected envelope')
    }
  })

  it('reads a page whose rows the provider sent as null as an empty list', async () => {
    // `null` is how this provider spells "no rows", so it ends the walk with nothing
    // found rather than failing the comparison.
    const projectDir = await project(manifestDocument({ items: [], lead_readonly_records: [] }))
    const { client } = stubTransport([], [], { assetRows: null })
    const report = await reconcileProject(client, projectDir)
    expect(report.source.asset_list_rows).toBe(0)
  })

  it('writes nothing when the manifest cannot be read', async () => {
    const projectDir = await projectWithoutManifest()
    const { client } = stubTransport(ALIVE, USED)
    await expect(reconcileProject(client, projectDir)).rejects.toThrow('assets_manifest.json 读不到')
    await expect(stat(join(projectDir, '_probe'))).rejects.toThrow()
  })

  it('refuses a manifest that is not JSON, is not an object, or carries no integer script_id', async () => {
    for (const [body, message] of [
      ['{not json', '不是合法 JSON'],
      ['[]', '顶层不是 JSON 对象'],
      ['{"items":[]}', '缺少整数 script_id'],
      ['{"script_id":"2708","items":[]}', '缺少整数 script_id'],
      ['{"script_id":2708.5,"items":[]}', '缺少整数 script_id'],
      ['{"script_id":2708,"items":{}}', 'items / lead_readonly_records 必须是数组'],
      ['{"script_id":2708,"items":[1],"lead_readonly_records":[]}', '清单里有记录不是 JSON 对象'],
    ] as const) {
      const projectDir = await projectWithoutManifest()
      await writeFile(join(projectDir, 'assets_manifest.json'), body, 'utf8')
      const { client } = stubTransport(ALIVE, USED)
      await expect(reconcileProject(client, projectDir)).rejects.toThrow(message)
    }
  })

  it('accepts a manifest with a byte-order mark and with the record arrays omitted', async () => {
    const projectDir = await projectWithoutManifest()
    await writeFile(join(projectDir, 'assets_manifest.json'), `\uFEFF${JSON.stringify({ script_id: 2708 })}`, 'utf8')
    const { client } = stubTransport([], [])
    const report = await reconcileProject(client, projectDir)

    expect(report.script_id).toBe(2708)
    expect(report.manifest).toEqual({ items: 0, lead_readonly_records: 0, asset_ids: 0 })
    expect(report.ready).toBe(true)
  })

  it('fails the call on existing evidence that is not a JSON object', async () => {
    for (const [body, detail] of [['{not json', '不是合法 JSON'], ['"text"', '顶层不是 JSON 对象'],
      ['null', '顶层不是 JSON 对象']] as const) {
      const projectDir = await project()
      await writeInto(evidencePath(projectDir), body)
      const { client } = stubTransport(ALIVE, USED)
      await expect(reconcileProject(client, projectDir)).rejects.toThrow(detail)
      await expect(readEvidence(projectDir)).rejects.toThrow(detail)
    }
  })

  it('builds a report without writing it, leaving the previous evidence in place', async () => {
    const projectDir = await project()
    const previous: Partial<ReconcileReport> = { cross_project_note: '上一轮的结论' }
    const before = JSON.stringify(previous)
    await writeInto(evidencePath(projectDir), before)
    const { client } = stubTransport(ALIVE, USED)
    const report = await buildReport(client, projectDir, previous, new Date('2026-09-20T07:12:20.000Z'))

    expect(report.cross_project_note).toBe('上一轮的结论')
    expect(await readFile(evidencePath(projectDir), 'utf8')).toBe(before)
  })

  it('reads a project that holds no evidence yet as an empty document', async () => {
    const projectDir = await project()
    expect(await readEvidence(projectDir)).toEqual({})
  })

  it('leaves no temporary file beside the evidence it wrote', async () => {
    const projectDir = await project()
    const { client } = stubTransport(ALIVE, USED)
    await reconcileProject(client, projectDir)
    expect(await readdir(join(projectDir, '_probe'))).toEqual(['asset-reconcile.json'])
  })
})

describe('disposeAsset', () => {
  it('records a registered disposition and clears the block', async () => {
    const projectDir = await project()
    const report = await reconcileWithBlock(projectDir, 7001)
    expect(report.ready).toBe(false)

    const updated = await disposeAsset(projectDir, 7001, 'registered', '')
    expect(updated.disposition['7001']).toEqual({ status: 'registered', note: '' })
    expect(updated.blocking).toEqual([])
    expect(updated.ignored_without_note).toEqual([])
    expect(updated.ready).toBe(true)

    const written = await evidence(projectDir)
    expect(written.disposition['7001']).toEqual({ status: 'registered', note: '' })
    expect(written.ready).toBe(true)
    // The call did not re-run the comparison, so the stamp it found is unchanged.
    expect(written.ran_at).toBe(report.ran_at)
  })

  it('records an ignored disposition with its reason and clears the block', async () => {
    const projectDir = await project()
    await reconcileWithBlock(projectDir, 7001)

    const updated = await disposeAsset(projectDir, 7001, 'ignored', '  失败遗留，确认不需要  ')
    expect(updated.disposition['7001']).toEqual({ status: 'ignored', note: '  失败遗留，确认不需要  ' })
    expect(updated.blocking).toEqual([])
    expect(updated.ignored_without_note).toEqual([])
    expect(updated.ready).toBe(true)
  })

  it('refuses an ignored disposition whose note holds only whitespace', async () => {
    const projectDir = await project()
    await reconcileWithBlock(projectDir, 7001)

    // The verdict itself would flag a blank note, but the call refuses it first:
    // an ignored asset without a stated reason is not a decision a person made.
    await expect(disposeAsset(projectDir, 7001, 'ignored', '   ')).rejects
      .toThrow('status=ignored 必须带非空 note')
    // The evidence the refusal would have edited is untouched.
    expect((await evidence(projectDir)).disposition['7001']).toEqual({ status: 'pending', note: '' })

    // A record an older run wrote with a blank note is data, and the comparison
    // reports it as an ignored asset that states no reason.
    await writeInto(evidencePath(projectDir), JSON.stringify({
      disposition: { 7001: { status: 'ignored', note: '   ' } },
    }))
    const { client } = stubTransport([...ALIVE, { id: 7001, delFlag: '0' }], [...USED,
      { id: 7002, assetId: 7001, isUsed: 1, hsAssetStatus: 'Active' }])
    const report = await reconcileProject(client, projectDir)
    expect(report.blocking).toEqual([])
    expect(report.ignored_without_note).toEqual([7001])
    expect(report.ready).toBe(false)
  })

  it('refuses an ignored disposition that carries no note at all', async () => {
    const projectDir = await project()
    await reconcileWithBlock(projectDir, 7001)
    await expect(disposeAsset(projectDir, 7001, 'ignored', '')).rejects
      .toThrow('status=ignored 必须带非空 note')
    await expect(disposeAsset(projectDir, 7001, 'ignored', '   ')).rejects
      .toThrow('status=ignored 必须带非空 note')
    // The refusal wrote nothing.
    expect((await evidence(projectDir)).disposition['7001']).toEqual({ status: 'pending', note: '' })
  })

  it('refuses an unknown status and an unusable asset id', async () => {
    const projectDir = await project()
    await expect(disposeAsset(projectDir, 7001, 'done', '')).rejects.toThrow('status 必须是 registered 或 ignored')
    await expect(disposeAsset(projectDir, 0, 'registered', '')).rejects.toThrow('asset_id 必须是正整数')
    await expect(disposeAsset(projectDir, 1.5, 'registered', '')).rejects.toThrow('asset_id 必须是正整数')
  })

  it('creates the evidence file when a project holds none', async () => {
    const projectDir = await project()
    const updated = await disposeAsset(projectDir, 83840, 'ignored', '项目里没有这张资产')

    expect(updated.disposition).toEqual({ 83840: { status: 'ignored', note: '项目里没有这张资产' } })
    // The verdict is computed from the dispositions alone, exactly as the pipeline's
    // own tool computes it; the evidence carries no comparison and no `ran_at`, so
    // the host gate still refuses it as unusable.
    expect(updated.ready).toBe(true)
    expect(await evidence(projectDir)).toEqual({
      disposition: { 83840: { status: 'ignored', note: '项目里没有这张资产' } },
      blocking: [], ignored_without_note: [], ready: true,
    })
  })

  it('keeps every other field of the evidence it edits', async () => {
    const projectDir = await project()
    await reconcileWithBlock(projectDir, 7001)
    await disposeAsset(projectDir, 7001, 'registered', '')

    const written = await evidence(projectDir)
    expect(written.script_id).toBe(2708)
    expect(written.matched).toBe(3)
    expect(written.policy.image_channel).toBe('KU_AI')
    expect(written.source.remote_alive).toBe(4)
  })
})

describe('deriveVerdicts', () => {
  it('treats any status other than registered and ignored as a block', () => {
    expect(deriveVerdicts({
      1: { status: 'pending', note: '' },
      2: { status: 'registered', note: '' },
      3: { status: 'ignored', note: '原因' },
      4: { status: 'ignored', note: '' },
    })).toEqual({ blocking: [1], ignored_without_note: [4] })
  })

  it('reports nothing for an empty map', () => {
    expect(deriveVerdicts({})).toEqual({ blocking: [], ignored_without_note: [] })
  })
})

/** Reconcile one project that holds a single unregistered asset, and return the report. */
async function reconcileWithBlock(projectDir: string, assetId: number): Promise<ReconcileReport> {
  const { client } = stubTransport([...ALIVE, { id: assetId, delFlag: '0' }], [...USED,
    { id: assetId + 1, assetId, isUsed: 1, hsAssetStatus: 'Active' }])
  return await reconcileProject(client, projectDir, new Date('2026-09-20T07:12:20.000Z'))
}
