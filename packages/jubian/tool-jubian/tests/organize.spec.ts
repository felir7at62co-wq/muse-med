import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import { resolveNaming } from '../src/naming.ts'
import { organizeMethod } from '../src/organize.ts'

const NAMING = resolveNaming()

/** The manifest a real project holds: `items` with declared episodes and Jubian ids. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 4, script_id: 2708, items: [
    { stable_id: 'char_lu', type: 'character', name: '陆沉舟', episodes: ['2', '05'],
      jubian_asset_id: 125204, jubian_material_id: 124527, official: true, asset_status: 'approved' },
    { stable_id: 'prop_hongbao', type: '道具', name: '红包', episodes: ['05'],
      jubian_asset_id: 125300, official: true, asset_status: 'approved' },
    { stable_id: 'scene_lobby', type: 'scene', name: '酒店大堂', episodes: [],
      jubian_asset_id: 125400, official: false, asset_status: 'pending' },
  ], ...overrides }
}

/** Assets as `/aigc/asset/list` answers: two pages, so paging is exercised. */
const ASSETS = [
  { id: 125204, name: '陆沉舟', assetType: 1 },
  { id: 125300, name: 'EP05｜道具｜红包', assetType: 3 },
  { id: 125400, name: 'EP03｜天台｜夜｜内', assetType: 1 },
  { id: 125500, name: 'scene_停车场', assetType: 1 },
]

/** A client stub answering the four reads the index performs. */
function stubClient(overrides: { tasks?: unknown; materials?: unknown; folders?: unknown
  assets?: Record<string, unknown>[] } = {}) {
  const calls: { method: string; path: string }[] = []
  const assets = overrides.assets ?? ASSETS
  const client = new JubianClient({ credential: async () => 'token',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const path = (url as URL).toString()
      calls.push({ method: String(init?.method), path })
      if (path.includes('/aigc/asset/list')) {
        const pageNum = Number(/pageNum=(\d+)/.exec(path)?.[1] ?? 1)
        const rows = pageNum === 1 ? assets.slice(0, 2) : assets.slice(2)
        return new Response(JSON.stringify({ code: 200, data: { total: assets.length, rows } }), { status: 200 })
      }
      if (path.includes('/aigc/material/list')) {
        return new Response(JSON.stringify({ code: 200, data: overrides.materials ?? { total: 1, rows: [
          { id: 124527, assetId: 125204, materialName: '陆沉舟', isUsed: 1, hsAssetStatus: 'Active' },
        ] } }), { status: 200 })
      }
      if (path.includes('/admin/aigc/video/task/list')) {
        return new Response(JSON.stringify({ code: 200, data: overrides.tasks ?? { total: 2, rows: [
          { id: 335343, taskStatus: 'succeeded', taskName: 'EP05-P1-sb12' },
          { id: 335344, taskStatus: 'running', taskName: 'sb13' },
        ] } }), { status: 200 })
      }
      if (path.includes('/aigc/assetFolder/tree')) {
        const category = /rootCategoryType=(\d+)/.exec(path)?.[1]
        return new Response(JSON.stringify({ code: 200, data: overrides.folders === undefined
          ? category === '1' ? [{ id: 11, folderName: 'EP05', children: [] }] : []
          : overrides.folders }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 200, data: null }), { status: 200 })
    } })
  return { calls, client }
}

let project: string
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'jubian-organize-'))
})

describe('organizeMethod', () => {
  it('builds the episode-by-category index from the manifest and the remote reads', async () => {
    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify(manifest()), 'utf8')
    const { calls, client } = stubClient()
    const index = await organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING })

    expect(index).toMatchObject({ script_id: 2708, project_dir: project, naming_checked: 5, video_tasks_total: 2 })
    // Two episodes from the manifest plus the one the video task names.
    const episodes = index.episodes as { label: string; asset_count: number; video_tasks: unknown[] }[]
    expect(episodes.map(episode => episode.label)).toEqual(['EP02', 'EP05'])
    expect(episodes[0]).toMatchObject({ asset_count: 1, video_tasks: [] })
    expect(episodes[1]).toMatchObject({ asset_count: 2 })
    expect(episodes[1]!.video_tasks).toHaveLength(1)

    const ep05 = episodes[1] as unknown as { categories: Record<string, { name: string; material_id: number | null
      remote_status: string | null }[]> }
    expect(ep05.categories['角色']![0]).toMatchObject({ name: '陆沉舟', material_id: 124527,
      remote_status: 'Active', asset_id: 125204, official: true, manifest_status: 'approved' })
    expect(ep05.categories['道具']![0]).toMatchObject({ name: '红包', material_id: null, remote_status: null })

    // The series master the manifest declares with no episode number.
    const series = index.series as Record<string, unknown[]>
    expect(series['场景']).toHaveLength(1)
    expect(series['角色']).toHaveLength(0)
    // Paged reads: two asset pages, then the materials, task and folder reads.
    expect(calls.filter(call => call.path.includes('/aigc/asset/list'))).toHaveLength(2)
  })

  it('reports the remote names that predate the convention', async () => {
    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify(manifest()), 'utf8')
    const { client } = stubClient()
    const index = await organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING })
    const violations = index.naming_violations as { source: string; name: string; reason: string }[]
    expect(violations.map(violation => violation.name)).toEqual(
      ['陆沉舟', 'EP03｜天台｜夜｜内', 'scene_停车场', '陆沉舟'])
    expect(violations.map(violation => violation.source)).toEqual(['asset', 'asset', 'asset', 'material'])
  })

  it('reports assets whose provider category disagrees with their manifest row or their own name', async () => {
    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify(manifest()), 'utf8')
    const { client } = stubClient()
    const index = await organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING })
    const mismatches = index.category_mismatches as { asset_id: number; expected: string; asset_type: number
      manifest_category: string | null; declared_category: string | null }[]
    // 125400 is the manifest's scene, and 125500's own name says scene, while both
    // sit in the provider's character library.
    expect(mismatches.map(item => item.asset_id)).toEqual([125400, 125500])
    expect(mismatches[0]).toMatchObject({ expected: '场景', asset_type: 1, manifest_category: '场景',
      declared_category: '场景' })
    expect(mismatches[1]).toMatchObject({ expected: '场景', manifest_category: null, declared_category: '场景' })
  })

  it('reports the remote assets no manifest row names', async () => {
    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify(manifest()), 'utf8')
    const { client } = stubClient()
    const index = await organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING })
    expect(index.unmatched_remote_assets).toEqual([{ asset_id: 125500, name: 'scene_停车场' }])
  })

  it('reads every category library and writes the index file beside the project', async () => {
    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify(manifest()), 'utf8')
    const { calls, client } = stubClient()
    const index = await organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING })
    expect(calls.filter(call => call.path.includes('/aigc/assetFolder/tree'))).toHaveLength(3)
    const folders = index.folders as Record<string, unknown[]>
    expect(folders['角色']).toEqual([{ folder_id: 11, name: 'EP05', children: [] }])
    expect(folders['道具']).toEqual([])

    const body = await readFile(join(project, '_probe', 'asset-index.md'), 'utf8')
    expect(body).toContain('# 资产组织索引')
    expect(body).toContain('## EP05（本集资产 2 项，视频任务 1 个）')
    expect(body).toContain('| 陆沉舟 | 是 | 125204 | 124527 | 陆沉舟 | Active |')
    expect(body).toContain('### 角色库')
    expect(body).toContain('- EP05（folder_id=11）')
    expect(body).toContain('## 类别审计')
    expect(body).toContain('## 命名审计')
    expect(body).toContain('## 未匹配的远端资产')
    expect(String(index.index_path)).toBe(join(project, '_probe', 'asset-index.md'))
  })

  it('takes a configured index path and refuses one that would leave the project', async () => {
    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify(manifest()), 'utf8')
    const { client } = stubClient()
    const index = await organizeMethod(client, { script_id: 2708, project_dir: project },
      { naming: NAMING, indexPath: join('reports', 'index.md') })
    expect(String(index.index_path)).toBe(join(project, 'reports', 'index.md'))
    await expect(organizeMethod(client, { script_id: 2708, project_dir: project },
      { naming: NAMING, indexPath: join('..', 'escaped.md') })).rejects.toThrow(/索引路径/)
  })

  it('renders an empty audit without inventing findings', async () => {
    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify(manifest({ items: [
      { type: 'character', name: '陆沉舟', episodes: ['05'], jubian_asset_id: 125204, official: true },
    ] })), 'utf8')
    const { client } = stubClient({ tasks: { total: 0, rows: [] }, materials: { total: 0, rows: [] },
      assets: [{ id: 125204, name: 'EP05｜角色｜陆沉舟', assetType: 1 }], folders: [] })
    const index = await organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING })
    expect(index.naming_violations).toEqual([])
    expect(index.category_mismatches).toEqual([])
    expect(index.unmatched_remote_assets).toEqual([])
    const body = await readFile(join(project, '_probe', 'asset-index.md'), 'utf8')
    expect(body).toContain('每个远端资产都在清单里有对应行')
    expect(body).toContain('（无文件夹）')
    expect(body).toContain('0 个不符合规范')
    expect(body).toContain('共 0 个资产的类别号')
  })

  it('requires script_id and project_dir', async () => {
    const { client } = stubClient()
    await expect(organizeMethod(client, { script_id: 2708 }, { naming: NAMING })).rejects.toThrow(/project_dir/)
    await expect(organizeMethod(client, { project_dir: project }, { naming: NAMING })).rejects.toThrow(/script_id/)
  })

  it('fails loud on a manifest it cannot read', async () => {
    const { client } = stubClient()
    await expect(organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING }))
      .rejects.toThrow(/assets_manifest.json 读不到/)

    await writeFile(join(project, 'assets_manifest.json'), '{ not json', 'utf8')
    await expect(organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING }))
      .rejects.toThrow(/不是 JSON/)

    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify({ version: 4 }), 'utf8')
    await expect(organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING }))
      .rejects.toThrow(/缺少 items 资产数组/)

    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify({ assets: [{}] }), 'utf8')
    await expect(organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING }))
      .rejects.toThrow(/有资产缺少 name 或 type/)

    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify({ items: ['x'] }), 'utf8')
    await expect(organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING }))
      .rejects.toThrow(/有资产行不是对象/)

    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify({ items: [
      { type: 'character', episodes: [] },
    ] }), 'utf8')
    await expect(organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING }))
      .rejects.toThrow(/缺少 name 或 type/)

    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify({ items: [
      { type: 'scene', name: 'x', episodes: ['番外'] },
    ] }), 'utf8')
    await expect(organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING }))
      .rejects.toThrow(/集号 番外 不是数字/)

    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify({ items: [
      { type: 'unknown', name: 'x', episodes: [] },
    ] }), 'utf8')
    await expect(organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING }))
      .rejects.toThrow(/缺少 name 或 type/)

    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify([{ type: 'scene' }]), 'utf8')
    await expect(organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING }))
      .rejects.toThrow(/顶层不是 JSON 对象/)
  })

  it('reads the assets array spelling some manifests carry', async () => {
    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify({ assets: [
      { type: 'scene', name: '酒店大堂', episodes: ['05'], asset_id: '125400', material_id: 1, official: true },
    ] }), 'utf8')
    const { client } = stubClient()
    const index = await organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING })
    const series = index.series as Record<string, unknown[]>
    // 125400 is declared for episode 05 here, so it is not a series master.
    expect(series['场景']).toHaveLength(0)
    const episodes = index.episodes as { label: string; categories: Record<string, unknown[]> }[]
    expect(episodes.find(episode => episode.label === 'EP05')).toBeDefined()
  })
})

describe('organizeMethod index cleanup', () => {
  it('leaves no temporary file behind', async () => {
    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify(manifest()), 'utf8')
    const { client } = stubClient()
    await organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING })
    const entries = await readFile(join(project, '_probe', 'asset-index.md'), 'utf8')
    expect(entries.endsWith('\n')).toBe(true)
    await rm(join(project, '_probe'), { recursive: true, force: true })
  })
})

describe('organizeMethod over a partly unreadable provider payload', () => {
  // Real payloads carry rows the index has to place without inventing values:
  // an asset the console never named, one it never typed, a material row with
  // no name, and a folder the provider left unnamed.
  const RAGGED_ASSETS = [
    { id: 125204, name: null, assetType: 3 },
    { id: 125300, name: 'EP05｜道具｜红包', assetType: 3 },
    { id: 125400, name: 'EP07｜场景｜天台', assetType: 1 },
    { id: 125500, name: 'scene_停车场' },
    { id: 125600 },
  ]

  /** A manifest row with no Jubian binding at all, plus a numeric name and a missing episodes array. */
  const RAGGED_MANIFEST = { items: [
    { type: 'character', name: 5, official: false },
    { type: 'scene', name: '酒店大堂', episodes: ['', '7'], jubian_asset_id: 125400, official: true },
    { type: 'prop', name: '红包', episodes: ['05'], jubian_asset_id: 125300, official: true },
    { type: 'character', name: '程野', episodes: ['05'], jubian_asset_id: 125204, official: true },
  ] }

  it('names what it could not read instead of dropping the row', async () => {
    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify(RAGGED_MANIFEST), 'utf8')
    const { client } = stubClient({ assets: RAGGED_ASSETS, materials: { total: 2, rows: [
      { id: 124527, assetId: 125204, materialName: null, isUsed: 1, hsAssetStatus: 'Active' },
      { id: 124528, materialName: 'EP05｜角色｜程野', isUsed: 1, hsAssetStatus: 'Wait' },
    ] }, tasks: { total: 3, rows: [
      { id: 335345, taskStatus: 'succeeded', taskName: null },
      { id: 335346, taskStatus: 'succeeded', taskName: 'EP07-P2-sb14' },
      { id: 335347, taskStatus: 'running', taskName: 'EP09-P1-sb15' },
    ] }, folders: [{ id: 21, children: [] }] })
    const index = await organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING })

    // Unnamed remote assets are reported as unmatched rather than dropped, and
    // the episode only a video task names still gets a bucket of its own.
    expect(index.unmatched_remote_assets).toEqual([
      { asset_id: 125500, name: 'scene_停车场' }, { asset_id: 125600, name: null }])
    expect(index.naming_checked).toBe(4)
    const episodes = index.episodes as { label: string; asset_count: number; video_tasks: unknown[] }[]
    expect(episodes.map(episode => episode.label)).toEqual(['EP05', 'EP07', 'EP09'])
    expect(episodes[0]).toMatchObject({ asset_count: 2 })
    expect(episodes[2]).toMatchObject({ asset_count: 0 })
    expect(episodes[2]!.video_tasks).toHaveLength(1)

    // The manifest row with no asset id keeps its own name and no remote status.
    const ep05 = episodes[0] as unknown as { categories: Record<string, { name: string; asset_id: number | null
      material_id: number | null; remote_status: string | null }[]> }
    expect(ep05.categories['道具']![0]).toMatchObject({ name: '红包', material_id: null, remote_status: null })
    expect(ep05.categories['角色']![0]).toMatchObject({ name: '程野', remote_status: 'Active' })
    const series = index.series as Record<string, { name: string; asset_id: number | null }[]>
    expect(series['角色']).toEqual([{ name: '5', official: false, asset_id: null, material_id: null,
      manifest_status: null, remote_name: null, remote_status: null }])

    // The character row the console never typed is left out of the audit rather
    // than guessed at; both real mismatches are reported.
    const mismatches = index.category_mismatches as { asset_id: number; declared_category: string | null }[]
    expect(mismatches.map(item => item.asset_id)).toEqual([125204, 125400])
    expect(mismatches[0]!.declared_category).toBeNull()
    expect(mismatches[1]!.declared_category).toBe('场景')

    const body = await readFile(join(project, '_probe', 'asset-index.md'), 'utf8')
    expect(body).toContain('| 5 | 否 | — | — | — | — |')
    expect(body).toContain('（无名称）')
    expect(body).toContain('asset 125204 （无名称）：assetType=3，应为 角色')
    expect(body).toContain('asset 125400 EP07｜场景｜天台：assetType=1，应为 场景')
  })

  it('reports a manifest-declared scene whose name declares nothing', async () => {
    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify({ items: [
      { type: 'scene', name: '酒店大堂', episodes: ['05'], jubian_asset_id: 125500, official: true },
    ] }), 'utf8')
    const { client } = stubClient({ assets: [{ id: 125500, name: '陆沉舟', assetType: 1 }], folders: [] })
    const index = await organizeMethod(client, { script_id: 2708, project_dir: project }, { naming: NAMING })
    const mismatches = index.category_mismatches as { manifest_category: string | null
      declared_category: string | null }[]
    expect(mismatches[0]).toMatchObject({ manifest_category: '场景', declared_category: null })
    const body = await readFile(join(project, '_probe', 'asset-index.md'), 'utf8')
    expect(body).toContain('名字声明 未声明')
  })
})
