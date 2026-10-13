/** Shared project queries through a real client with instance-local, GET-only provider fixtures. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import { encodeVoiceSlot } from '@deepseek-ai/dsh-jubian-api'
import { sharedUsagePreview, type SharedUsageFilter, type SharedUsageLimits } from '../src/shared-usage.ts'

type Row = Record<string, unknown>
type Kind = 'asset' | 'material' | 'episode' | 'storyboard'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }) })
const limits: SharedUsageLimits = { pageSize: 2, pageLimit: 20, outputLimit: 100 }
const tag = (period: string): string => encodeVoiceSlot(2708, 'lu', period)
const voiceUrl = 'https://example.invalid/adult.wav'
async function fixture(options: {
  config?: unknown
  manifest?: unknown
  edit?: (lists: Record<Kind, Row[]>) => void
  page?: (kind: Kind, page: number, round: number, body: Row) => unknown
  before?: (root: string) => Promise<void>
  request?: (url: URL, signal: AbortSignal | null | undefined) => Promise<void>
} = {}): Promise<{ root: string; client: JubianClient; calls: string[]; lists: Record<Kind, Row[]> }> {
  const root = await mkdtemp(join(tmpdir(), 'muse-shared-usage-')); roots.push(root)
  await writeFile(join(root, 'project_config.json'), JSON.stringify(options.config ?? { jubian_script_id: 2708 }))
  if (options.manifest !== undefined) await writeFile(join(root, 'assets_manifest.json'), JSON.stringify(options.manifest))
  const lists: Record<Kind, Row[]> = {
    asset: [
      { id: 11, scriptId: 2708, assetType: 1, assetName: '陆沉舟职场装', url: 'https://example.invalid/person.png', delFlag: '0' },
      { id: 12, scriptId: 2708, assetType: 2, assetName: '大厅', url: 'https://example.invalid/room.png', delFlag: '0' },
      { id: 13, scriptId: 2708, assetType: 3, assetName: '手机', url: 'https://example.invalid/phone.png', delFlag: '0' },
      { id: 14, scriptId: 2708, assetType: 4, assetName: `成年声音 ${tag('adult')}`, url: voiceUrl, delFlag: '0' },
      { id: 15, scriptId: 2708, assetType: 4, assetName: `重复成年 ${tag('adult')}`, url: 'https://example.invalid/adult2.wav', delFlag: '0' },
      { id: 16, scriptId: 2708, assetType: 4, assetName: `儿童声音 ${tag('child')}`, assetUrl: 'https://example.invalid/child.wav', delFlag: 0 },
    ],
    material: [
      { id: 111, scriptId: 2708, assetId: 11, assetUrl: 'https://example.invalid/person.png' },
      { id: 114, scriptId: 2708, assetId: 14, assetUrl: voiceUrl },
      { id: 115, scriptId: 2708, assetId: 15, assetUrl: 'https://example.invalid/adult2.wav' },
    ],
    episode: [{ id: 900, scriptId: 2708, episodeCount: 54, episodeName: '五十四集' }, { id: 901, episodeCount: '83', name: '八十三集' }],
    storyboard: [
      { id: 200, scriptId: 2708, episodeId: 900, storyboardName: 'ep54-p01', storyboardMaterialList: [
        { materialType: 'image', materialUrl: 'https://example.invalid/person.png', materialAssetId: 11, materialId: 111 },
        { materialType: 'image', materialUrl: 'https://example.invalid/room.png' },
        { materialType: 'image', materialUrl: 'https://example.invalid/phone.png' },
        { materialType: 'audio', materialUrl: voiceUrl },
      ], modelConfig: { materialList: [{ materialType: 'audio', materialUrl: voiceUrl }] } },
      { id: 201, scriptId: 2708, episodeId: '901', storyboardName: 'ep83-p01', storyboardMaterialList: JSON.stringify([
        { materialType: 'audio', materialUrl: 'https://example.invalid/adult2.wav', assetId: '15' },
      ]), modelConfig: JSON.stringify({ materialList: null }) },
      { id: 202, scriptId: 2708, episodeId: null, modelConfig: null, storyboardMaterialList: [] },
    ],
  }
  options.edit?.(lists)
  const calls: string[] = [], rounds = new Map<Kind, number>()
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if ((init?.method ?? 'GET') !== 'GET') throw new Error('Forbidden write in shared usage fixture')
    if (url.searchParams.get('scriptId') !== '2708') throw new Error('Foreign project request')
    calls.push(url.pathname + url.search)
    await options.before?.(root)
    await options.request?.(url, init?.signal)
    const kind = url.pathname.split('/').at(-2) as Kind, page = Number(url.searchParams.get('pageNum')), size = Number(url.searchParams.get('pageSize'))
    if (page === 1) rounds.set(kind, (rounds.get(kind) ?? 0) + 1)
    const body: Row = { total: lists[kind].length, rows: lists[kind].slice((page - 1) * size, page * size) }
    const data = options.page ? options.page(kind, page, rounds.get(kind)!, body) : body
    return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
  }
  return { root, lists, calls, client: new JubianClient({ credential: async () => 'offline-test-token', fetch: transport }) }
}
async function preview(f: Awaited<ReturnType<typeof fixture>>, filter: SharedUsageFilter = {}, readLimits = limits) {
  return await sharedUsagePreview(f.client, f.root, filter, readLimits)
}

it('counts distinct current packages across complete stable inventories without requiring a manifest', async () => {
  const f = await fixture(), original = await readFile(join(f.root, 'project_config.json'))
  const result = await preview(f)
  expect(result.complete).toBe(true)
  expect(result.stable_inventory).toBe(true)
  expect(result.assets.map(row => [row.asset_id, row.package_count])).toEqual([[11, 1], [12, 1], [13, 1], [14, 1], [15, 1], [16, 0]])
  expect(result.uses).toHaveLength(5)
  expect(result.uses[0]).toMatchObject({ asset_id: 11, material_ids: [111], episode_id: 900, episode_number: 54, storyboard_id: 200 })
  expect(result.uses.at(-1)).toMatchObject({ asset_id: 15, material_ids: [115], episode_number: 83 })
  expect(result.duplicate_audio_groups).toEqual([{ character_id: 'lu', voice_period_id: 'adult', asset_ids: [14, 15],
    preferred_asset_id: 14, current_local_asset_ids: [], selection: 'most_current_packages_then_lowest_id', speaker_verified: false, delete_allowed: false }])
  expect(result.coverage).toEqual({ current_remote_packages: true, character_identity_complete: false,
    historical_generation_tasks: false, other_computers_local_plans: false,
    other_accounts_voice_defaults: false, atomic_remote_snapshot: false })
  expect(result).toMatchObject({ read_only: true, paid_requests: 0, remote_writes: 0, local_writes: 0, truncated: false })
  expect(f.calls).toHaveLength(16)
  expect(await readFile(join(f.root, 'project_config.json'))).toEqual(original)
})
it('prefers the most currently bound packages and preserves unknown episode identity', async () => {
  const f = await fixture({ edit: (lists) => { lists.storyboard[2] = { id: 202, scriptId: 2708, storyboardMaterialList: [
    { materialType: 'audio', materialUrl: 'https://example.invalid/adult2.wav' }], episodeId: 999 } } })
  const result = await preview(f)
  expect(result.duplicate_audio_groups[0]?.preferred_asset_id).toBe(15)
  expect(result.uses.at(-1)).toMatchObject({ episode_id: 999, episode_number: null, episode_name: null, storyboard_name: null })
})
it('retains one locally adopted period even when another audio has more current packages', async () => {
  const f = await fixture({ config: { jubian_script_id: 2708, project_bible: { characters: [{ character_id: 'lu',
    voice_profiles: [{ voice_period_id: 'adult', reference_audio_asset_id: 15, reference_audio: 'https://example.invalid/adult2.wav' }] }] } } })
  const result = await preview(f)
  expect(result.assets.find(row => row.asset_id === 15)?.current_local_voice).toBe(true)
  expect(result.duplicate_audio_groups[0]).toMatchObject({ preferred_asset_id: 15, current_local_asset_ids: [15], selection: 'retain_local_adopted' })
})
it('does not choose between multiple already adopted audio identities', async () => {
  const f = await fixture({ config: { jubian_script_id: 2708, project_bible: { characters: [
    { character_id: 'lu', voice_profiles: [{ voice_period_id: 'adult', reference_audio_asset_id: 14, reference_audio: voiceUrl }] },
    { character_id: 'lu', voice_profiles: [{ voice_period_id: 'adult', reference_audio_asset_id: 15, reference_audio: 'https://example.invalid/adult2.wav' }] },
  ] } } })
  expect((await preview(f)).duplicate_audio_groups[0]).toMatchObject({ preferred_asset_id: null, current_local_asset_ids: [14, 15] })
})
it('groups no untagged, malformed, foreign or other-period audio as duplicate identity', async () => {
  const f = await fixture({ edit: (lists) => { lists.asset[4]!.assetName = 'same human label'; lists.asset.push(
    { id: 17, assetType: 4, delFlag: '0', assetName: '⟦muse-voice:v1:broken⟧' },
    { id: 18, assetType: 4, delFlag: '0', assetName: encodeVoiceSlot(2709, 'lu', 'adult') }) } })
  expect((await preview(f)).duplicate_audio_groups).toEqual([])
})
it('maps explicit local manifest character IDs across costumes and filters after a full project read', async () => {
  const f = await fixture({ manifest: { script_id: 2708, items: [
    { jubian_asset_id: 11, jubian_material_id: 111, official: true, type: 'character', character_id: 'lu', url: 'https://example.invalid/person.png' },
    { jubian_asset_id: 17, jubian_material_id: 117, official: true, type: '角色', character_id: 'lu', url: 'https://example.invalid/costume.png' },
    null, { jubian_asset_id: 13, character_id: 'unrelated', url: 'not-the-registered-url' },
  ], lead_readonly_records: [] }, edit: (lists) => {
    lists.asset.push({ id: 17, assetType: 1, delFlag: '0', name: '陆沉舟礼服', url: 'https://example.invalid/costume.png' })
    lists.material.push({ id: 117, assetId: 17, assetUrl: 'https://example.invalid/costume.png' })
  } })
  const result = await preview(f, { character_id: 'lu' })
  expect(result.assets.map(row => row.asset_id)).toEqual([11, 14, 15, 16, 17])
  expect(result.assets[0]).toMatchObject({ identity_source: 'local_manifest', character_id: 'lu' })
  expect((await preview(f, { asset_id: 13 })).assets[0]).toMatchObject({ character_id: null, identity_source: 'unknown' })
})
it.each([
  { jubian_asset_id: 13, jubian_material_id: 111, type: 'character' },
  { jubian_asset_id: 12, jubian_material_id: 111, type: 'character' },
  { jubian_asset_id: 11, jubian_material_id: 111, type: 'prop' },
  { jubian_asset_id: 11, jubian_material_id: 111, type: 'character', official: false },
  { jubian_asset_id: 11, jubian_material_id: 112, type: 'character' },
  { jubian_asset_id: 11, type: 'character' },
  { jubian_asset_id: 11, jubian_material_id: 111, type: 'character', name: 'different person' },
  { jubian_asset_id: 11, jubian_material_id: 111, type: 'character', url: null },
])('refuses local candidates that contradict the registered category or identity %j', async (change) => {
  const f = await fixture({ manifest: { script_id: 2708, items: [{ official: true, character_id: 'wrong',
    url: 'https://example.invalid/person.png', ...change }] } })
  const result = await preview(f, { character_id: 'wrong' })
  expect(result.assets).toEqual([])
  expect(result.issues.some(row => row.code === 'LOCAL_ASSET_IDENTITY_CONTRADICTION')).toBe(true)
})
it('accepts equal optional local names and material ID aliases after exact remote verification', async () => {
  const f = await fixture({ manifest: { script_id: 2708, items: [{ official: true, character_id: 'lu', type: '人物',
    jubian_asset_id: 11, jubian_material_id: 111, name: '陆沉舟职场装', url: 'https://example.invalid/person.png' }] },
  edit: (lists) => { lists.material[0]!.materialId = lists.material[0]!.id; delete lists.material[0]!.id } })
  const result = await preview(f)
  expect(result.assets[0]?.identity_source).toBe('local_manifest')
  expect(result.uses[0]?.material_ids).toEqual([111])
})
it('does not adopt a local voice ID with no current URL', async () => {
  const f = await fixture({ config: { jubian_script_id: 2708, project_bible: { characters: [{ character_id: 'lu',
    voice_profile: { reference_audio_asset_id: 14 } }] } } })
  expect((await preview(f)).assets.find(row => row.asset_id === 14)?.current_local_voice).toBe(false)
})
it('reports partial character-query coverage without invalidating exact current-package counts', async () => {
  const f = await fixture(), result = await preview(f, { character_id: 'lu' })
  expect(result).toMatchObject({ complete: true, query_complete: false, coverage: { character_identity_complete: false } })
  expect(result.assets.map(row => row.asset_id)).toEqual([14, 15, 16])
  expect(result.assets.find(row => row.asset_id === 14)?.package_count).toBe(1)
  expect(result.issues).toMatchObject([{ code: 'CHARACTER_FILTER_PARTIAL', inventory: 'query', ids: [11] }])
  expect(result.next).toContain('only identified assets')
  expect(result.next).toContain('unrelated project work can continue')
  const byId = await preview(f, { asset_id: 11 })
  expect(byId).toMatchObject({ complete: true, query_complete: true })
  expect(byId.assets[0]?.package_count).toBe(1)
})
it('does not present an empty character query as evidence of no uses when role identities are unmapped', async () => {
  const result = await preview(await fixture(), { character_id: 'unknown-character' })
  expect(result.assets).toEqual([])
  expect(result.uses).toEqual([])
  expect(result.query_complete).toBe(false)
  expect(result.next).toContain('Query unknown role or voice assets by exact asset_id')
})
it('requires explicit voice identity as well as role identity to complete a character query', async () => {
  const f = await fixture({ manifest: { script_id: 2708, items: [{ official: true, type: 'character', character_id: 'lu',
    jubian_asset_id: 11, jubian_material_id: 111, url: 'https://example.invalid/person.png' }] },
  edit: (lists) => { lists.asset[4]!.assetName = 'untagged human voice' } })
  const result = await preview(f, { character_id: 'lu' })
  expect(result).toMatchObject({ complete: true, query_complete: false, coverage: { character_identity_complete: false } })
  expect(result.issues[0]?.ids).toEqual([15])
})
it('completes a character query only when current role and voice identities are explicit', async () => {
  const f = await fixture({ manifest: { script_id: 2708, items: [{ official: true, type: 'character', character_id: 'lu',
    jubian_asset_id: 11, jubian_material_id: 111, url: 'https://example.invalid/person.png' }] } })
  expect(await preview(f, { character_id: 'lu' })).toMatchObject({ complete: true, query_complete: true,
    coverage: { character_identity_complete: true } })
})
it('reports contradictory local voice identity instead of overriding a remote life period', async () => {
  const f = await fixture({ config: { jubian_script_id: 2708, project_bible: { characters: [{ character_id: 'another',
    voice_profiles: [{ voice_period_id: 'child', reference_audio_asset_id: 14, reference_audio: voiceUrl }] }] } } })
  const result = await preview(f)
  expect(result.issues[0]?.code).toBe('LOCAL_VOICE_IDENTITY_CONTRADICTION')
  expect(result.assets.find(row => row.asset_id === 14)?.current_local_voice).toBe(false)
})
it('keeps obsolete local references unadopted and accepts verified legacy current references', async () => {
  const f = await fixture({ config: { jubian_script_id: 2708, project_bible: { characters: [{ character_id: 'lu',
    voice_profile: { reference_audio_asset_id: 15, reference_audio: 'not-current' },
    voice_profiles: [{ voice_period_id: 'child', reference_audio_asset_id: 999, reference_audio: 'missing' }] }] } },
  edit: (lists) => { lists.asset[4]!.assetName = 'legacy' } })
  expect((await preview(f)).assets.some(row => row.current_local_voice)).toBe(false)
  await writeFile(join(f.root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708,
    project_bible: { characters: [{ character_id: 'lu', voice_profile: { reference_audio_asset_id: 15, reference_audio: 'https://example.invalid/adult2.wav' } }] } }))
  expect((await preview(f)).assets.find(row => row.asset_id === 15)?.current_local_voice).toBe(true)
})
it('reports local manifest ambiguities or a foreign local manifest without name guessing', async () => {
  const f = await fixture({ manifest: { script_id: 2708, items: [
    { jubian_asset_id: 11, jubian_material_id: 111, official: true, type: 'character', character_id: 'lu', url: 'https://example.invalid/person.png' },
    { jubian_asset_id: 11, jubian_material_id: 111, official: true, type: 'character', character_id: 'different', url: 'https://example.invalid/person.png' },
  ] } })
  expect((await preview(f)).issues[0]?.code).toBe('AMBIGUOUS_LOCAL_CHARACTER')
  await writeFile(join(f.root, 'assets_manifest.json'), JSON.stringify({ script_id: 2709 }))
  expect((await preview(f)).issues[0]?.code).toBe('FOREIGN_LOCAL_MANIFEST')
})
it('makes shared URLs ambiguous until an exact parent identity resolves the reference', async () => {
  const f = await fixture({ edit: (lists) => { lists.asset[4]!.url = voiceUrl; lists.material[2]!.assetUrl = voiceUrl
    lists.storyboard[1]!.storyboardMaterialList = [] } })
  const ambiguous = await preview(f)
  expect(ambiguous.issues.some(row => row.code === 'AMBIGUOUS_REFERENCE_URL')).toBe(true)
  expect(ambiguous.assets.every(row => row.package_count === null)).toBe(true)
  f.lists.storyboard[0]!.storyboardMaterialList = [{ materialType: 'audio', materialUrl: voiceUrl, assetId: 14 }]
  f.lists.storyboard[0]!.modelConfig = null
  expect((await preview(f)).assets.find(row => row.asset_id === 14)?.package_count).toBe(1)
})
it('uses exact generated-material URLs and material IDs independently of parent URL', async () => {
  const f = await fixture({ edit: (lists) => {
    delete lists.asset[0]!.url
    lists.material[0]!.assetUrl = 'https://example.invalid/generated.png'
    lists.storyboard[0]!.storyboardMaterialList = [{ materialType: 'image', materialUrl: 'https://example.invalid/generated.png', materialId: 111 }]
    lists.storyboard[0]!.modelConfig = { materialList: [] }
  } })
  expect((await preview(f)).uses[0]).toMatchObject({ asset_id: 11, material_ids: [111] })
})
it('keeps separate material URLs within one parent counted as one current package', async () => {
  const f = await fixture({ edit: (lists) => {
    lists.material.push({ id: 112, assetId: 11, materialUrl: 'https://example.invalid/alternate.png' })
    lists.storyboard[0]!.modelConfig = { materialList: [{ materialType: 'image', materialUrl: 'https://example.invalid/alternate.png' }] }
  } })
  const result = await preview(f)
  expect(result.uses[0]?.material_ids).toEqual([111, 112])
  expect(result.assets[0]?.package_count).toBe(1)
})
it('reports a contradictory explicit material URL instead of choosing a parent by name', async () => {
  const f = await fixture({ edit: (lists) => {
    lists.storyboard[0]!.storyboardMaterialList = [{ materialType: 'image', materialUrl: 'https://example.invalid/person.png', materialId: 111 }]
    lists.material[0]!.assetUrl = 'https://example.invalid/alternate.png'; lists.storyboard[0]!.modelConfig = null
  } })
  expect((await preview(f)).issues[0]?.code).toBe('CONTRADICTORY_MATERIAL_URL')
})
it.each([
  [null, 'UNREADABLE_REFERENCE'],
  [{ materialType: 'image' }, 'INVALID_REFERENCE_IDENTITY'],
  [{ materialType: 'audio', materialUrl: voiceUrl, url: 'different' }, 'INVALID_REFERENCE_IDENTITY'],
  [{ materialType: 'audio', materialUrl: voiceUrl, assetId: '0' }, 'INVALID_REFERENCE_IDENTITY'],
  [{ materialType: 'audio', materialUrl: voiceUrl, assetId: 14, materialAssetId: 15 }, 'INVALID_REFERENCE_IDENTITY'],
  [{ materialType: 'audio', materialUrl: voiceUrl, materialId: false }, 'INVALID_REFERENCE_IDENTITY'],
  [{ materialType: 'unsupported', materialUrl: voiceUrl }, 'INVALID_REFERENCE_IDENTITY'],
  [{ materialType: 'audio', materialUrl: voiceUrl, materialId: 111 }, 'UNRESOLVED_REFERENCE'],
  [{ materialType: 'audio', materialUrl: voiceUrl, assetId: 11 }, 'UNRESOLVED_REFERENCE'],
  [{ materialType: 'image', materialUrl: voiceUrl }, 'UNRESOLVED_REFERENCE'],
] as const)('retains incomplete counts for invalid or contradictory reference %j', async (reference, expected) => {
  const f = await fixture({ edit: (lists) => {
    lists.storyboard[0]!.storyboardMaterialList = [reference]; lists.storyboard[0]!.modelConfig = null
  } })
  const result = await preview(f)
  expect(result.complete).toBe(false)
  expect(result.issues[0]?.code).toBe(expected)
  expect(result.assets.every(row => row.package_count === null && ! row.delete_allowed)).toBe(true)
})
it.each([
  [{ modelConfig: '{', storyboardMaterialList: [] }, 'UNREADABLE_CONFIG'],
  [{ modelConfig: 'false', storyboardMaterialList: [] }, 'UNREADABLE_CONFIG'],
  [{ modelConfig: null }, 'REFERENCE_FIELDS_MISSING'],
  [{ storyboardMaterialList: '{}' }, 'UNREADABLE_REFERENCES'],
  [{ storyboardMaterialList: '{' }, 'UNREADABLE_REFERENCES'],
  [{ storyboardMaterialList: [], episodeId: false }, 'UNREADABLE_EPISODE_ID'],
] as const)('reports incomplete card input %j', async (fields, code) => {
  const f = await fixture({ edit: (lists) => { lists.storyboard[0] = { id: 200, scriptId: 2708, ...fields } } })
  expect((await preview(f)).issues[0]?.code).toBe(code)
})
it('does not turn unreadable episode numbers into row positions or names', async () => {
  const f = await fixture({ edit: (lists) => { lists.episode[0]!.episodeCount = false; lists.episode[1]!.episodeCount = 0 } })
  expect((await preview(f)).uses.every(row => row.episode_number === null)).toBe(true)
})
it('ignores deleted assets, exposes unknown liveness, and refuses orphaned materials as a complete view', async () => {
  const f = await fixture({ edit: (lists) => { lists.asset.push({ id: 99, delFlag: '1' }, { id: 100, delFlag: 1 }, { id: 101 },
    { id: 102, delFlag: '0', assetType: 'image', name: 'unknown category' })
  lists.material.push({ id: 999, assetId: 99 }, { id: 998, assetId: null }, { id: 997, assetId: false }) } })
  const result = await preview(f)
  expect(result.assets.map(row => row.asset_id)).not.toContain(99)
  expect(result.assets.at(-1)).toMatchObject({ asset_id: 102, asset_type: null, urls: [] })
  expect(result.issues.map(row => row.code)).toEqual(['ASSET_LIVENESS_UNKNOWN', 'MATERIAL_PARENT_UNRESOLVED', 'MATERIAL_PARENT_UNRESOLVED'])
})
it('returns bounded result arrays while retaining complete inventory totals', async () => {
  const f = await fixture(), result = await preview(f, {}, { ...limits, outputLimit: 1 })
  expect(result).toMatchObject({ complete: true, truncated: true, totals: { assets: 6, uses: 5, duplicate_audio_groups: 1, issues: 0 } })
  expect(result.assets).toHaveLength(1)
  expect(result.uses).toHaveLength(1)
  expect(result.pagination).toMatchObject({ output_offset: 0, output_limit: 1, next_offset: 1 })
  expect(result.next).toContain('Request output_offset=1')
  expect(result.next).toContain('pagination.query_sha256 matches')
})
it('paginates an exact asset with more than one hundred package uses without requiring a configuration change', async () => {
  const f = await fixture({ edit: (lists) => {
    lists.storyboard = Array.from({ length: 121 }, (_, index) => ({ id: 1000 + index, scriptId: 2708,
      episodeId: 901, storyboardName: `ep83-p${index + 1}`, storyboardMaterialList: [{ materialType: 'audio', materialUrl: voiceUrl }] }))
  } })
  const readLimits = { ...limits, pageSize: 20 }
  const first = await preview(f, { asset_id: 14 }, readLimits)
  const last = await preview(f, { asset_id: 14, output_offset: 100 }, readLimits)
  expect(first).toMatchObject({ complete: true, query_complete: false, truncated: true, totals: { assets: 1, uses: 121 } })
  expect(first.assets[0]?.package_count).toBe(121)
  expect(first.pagination).toMatchObject({ output_offset: 0, output_limit: 100, next_offset: 100 })
  expect(first.uses).toHaveLength(100)
  expect(last.assets).toEqual([])
  expect(last.uses).toHaveLength(21)
  expect(last).toMatchObject({ complete: true, query_complete: false, truncated: true, totals: { assets: 1, uses: 121 } })
  expect(last.pagination).toMatchObject({ output_offset: 100, next_offset: null, query_sha256: first.pagination.query_sha256 })
  expect(last.next).toContain('empty assets array on a later page does not establish asset absence')
  expect(new Set([...first.uses, ...last.uses].map(row => row.storyboard_id)).size).toBe(121)
})
it('retains query totals and a terminal page even when the requested offset is past the last row', async () => {
  const f = await fixture(), result = await preview(f, { output_offset: 9000 })
  expect(result).toMatchObject({ complete: true, query_complete: false, truncated: true, totals: { assets: 6, uses: 5 } })
  expect(result.assets).toEqual([])
  expect(result.uses).toEqual([])
  expect(result.pagination.next_offset).toBeNull()
})
it('keeps one hash across output offsets and limits but changes it when the selector or current bindings change', async () => {
  const f = await fixture(), first = await preview(f)
  const later = await preview(f, { output_offset: 2 }, { ...limits, outputLimit: 2 })
  expect(later.pagination.query_sha256).toBe(first.pagination.query_sha256)
  expect((await preview(f, { asset_id: 14 })).pagination.query_sha256).not.toBe(first.pagination.query_sha256)
  f.lists.storyboard[2]!.storyboardMaterialList = [{ materialType: 'audio', materialUrl: voiceUrl }]
  expect((await preview(f)).pagination.query_sha256).not.toBe(first.pagination.query_sha256)
})
it('changes the cross-page hash when the local adopted voice changes while remote rows remain identical', async () => {
  const f = await fixture(), first = await preview(f)
  await writeFile(join(f.root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708,
    project_bible: { characters: [{ character_id: 'lu', voice_profiles: [{ voice_period_id: 'adult',
      reference_audio_asset_id: 15, reference_audio: 'https://example.invalid/adult2.wav' }] }] } }))
  expect((await preview(f, { output_offset: 1 })).pagination.query_sha256).not.toBe(first.pagination.query_sha256)
})
it('sorts provider row-order variations into the same current query and hash', async () => {
  const f = await fixture(), first = await preview(f)
  for (const kind of Object.keys(f.lists) as Kind[]) f.lists[kind].reverse()
  const reordered = await preview(f)
  expect(reordered.pagination.query_sha256).toBe(first.pagination.query_sha256)
  expect(reordered.assets).toEqual(first.assets)
  expect(reordered.uses).toEqual(first.uses)
  expect(reordered.duplicate_audio_groups).toEqual(first.duplicate_audio_groups)
})
it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])('refuses invalid output offset %s', async (offset) => {
  await expect(preview(await fixture(), { output_offset: offset })).rejects.toThrow('nonnegative safe integer')
})
it.each([
  [null, 'UNREADABLE_PAGE'], [{ rows: [], total: -1 }, 'UNREADABLE_PAGE'], [{ rows: [], total: '0' }, 'UNREADABLE_PAGE'],
  [{ rows: {}, total: 0 }, 'UNREADABLE_PAGE'], [{ rows: [], total: 0.5 }, 'UNREADABLE_PAGE'],
  [{ rows: [], total: 2 }, 'INCOMPLETE_PAGE'], [{ rows: [null], total: 1 }, 'INVALID_PAGE_IDENTITY'],
  [{ rows: [{ id: 'bad' }], total: 1 }, 'INVALID_PAGE_IDENTITY'],
  [{ rows: [{ id: 1, materialId: 2 }], total: 1 }, 'INVALID_PAGE_IDENTITY'],
  [{ rows: [{ id: 1, scriptId: 2709 }], total: 1 }, 'INVALID_PAGE_IDENTITY'],
  [{ rows: [{ id: 1, scriptId: 2708 }, { id: 1, scriptId: 2708 }], total: 2 }, 'INVALID_PAGE_IDENTITY'],
  [{ rows: [{ id: 1 }, { id: 2 }], total: 1 }, 'INCOMPLETE_PAGE'],
  [{ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], total: 3 }, 'CHANGING_PAGE'],
] as const)('does not report zero after malformed material page %j', async (page, code) => {
  const f = await fixture({ page: (kind, _page, _round, body) => kind === 'material' ? page : body })
  const result = await preview(f)
  expect(result.issues[0]?.code).toBe(code)
  expect(result.complete).toBe(false)
  expect(result.assets.every(row => row.package_count === null)).toBe(true)
  expect(result.duplicate_audio_groups[0]).toMatchObject({ preferred_asset_id: null, selection: 'inspection_incomplete' })
})
it('refuses missing storyboard project identity and preserves valid aliases from other inventories', async () => {
  const f = await fixture({ edit: (lists) => { lists.asset[0]!.assetId = lists.asset[0]!.id; delete lists.asset[0]!.id
    lists.material[0]!.materialId = lists.material[0]!.id; delete lists.material[0]!.id
    delete lists.storyboard[0]!.scriptId } })
  expect((await preview(f)).issues.some(row => row.code === 'INVALID_PAGE_IDENTITY' && row.inventory === 'storyboard')).toBe(true)
})
it('reports changed totals across pages and an exhausted page bound', async () => {
  const f = await fixture({ page: (kind, page, _round, body) => kind === 'asset' && page === 2 ? { ...body, total: 99 } : body })
  expect((await preview(f)).issues[0]).toMatchObject({ code: 'CHANGING_PAGE', inventory: 'asset' })
  const another = await fixture()
  expect((await preview(another, {}, { ...limits, pageLimit: 1 })).issues.some(row => row.code === 'PAGE_LIMIT')).toBe(true)
})
it('detects same-total inventory mutations and incomplete second reads', async () => {
  const f = await fixture({ page: (kind, _page, round, body) => kind === 'asset' && round === 2
    ? { ...body, rows: (body.rows as Row[]).map(row => ({ ...row, assetName: 'changed' })) } : body })
  expect((await preview(f)).issues.some(row => row.code === 'INVENTORY_CHANGED')).toBe(true)
  const second = await fixture({ page: (kind, _page, round, body) => kind === 'material' && round === 2 ? null : body })
  expect((await preview(second)).issues.some(row => row.code === 'INVENTORY_CHANGED')).toBe(true)
})
it('permits complete empty inventories and input row-order changes without a global-unused claim', async () => {
  const f = await fixture({ edit: (lists) => { for (const kind of Object.keys(lists) as Kind[]) lists[kind] = [] } })
  const result = await preview(f)
  expect(result).toMatchObject({ complete: true, totals: { assets: 0, uses: 0, duplicate_audio_groups: 0, issues: 0 } })
  const reordered = await fixture({ page: (kind, _page, round, body) => kind === 'episode' && round === 2 ? { ...body, rows: [...body.rows as Row[]].reverse() } : body })
  expect((await preview(reordered)).complete).toBe(true)
})
it('rejects changing local project bytes during the shared read', async () => {
  let changed = false
  const f = await fixture({ before: async (root) => { if (!changed) { changed = true; await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2709 })) } } })
  await expect(preview(f)).rejects.toThrow('changed during')
})
it.each([
  [null], [[]], [{ jubian_script_id: false }], [{ jubian_script_id: 0 }], [{ jubian_script_id: '02708' }],
  [{ jubian_script_id: 2708, project_bible: { characters: {} } }],
  [{ jubian_script_id: 2708, project_bible: { characters: [null] } }],
  [{ jubian_script_id: 2708, project_bible: { characters: [{}] } }],
] as const)('rejects invalid current project input %j', async (config) => {
  const f = await fixture()
  await writeFile(join(f.root, 'project_config.json'), JSON.stringify(config))
  await expect(preview(f)).rejects.toThrow()
})
it('propagates invalid optional local manifests instead of guessing character identity', async () => {
  const f = await fixture({ manifest: [] })
  await expect(preview(f)).rejects.toThrow()
})
it.each([{ asset_id: 0 }, { asset_id: 1.5 }, { character_id: '' }, { character_id: ' ' }])('rejects invalid filter %j', async (filter) => {
  await expect(preview(await fixture(), filter)).rejects.toThrow('identities')
})
it.each([
  { pageSize: 0 }, { pageSize: 1001 }, { pageSize: 1.5 }, { pageLimit: 0 }, { pageLimit: 1.5 },
  { outputLimit: 0 }, { outputLimit: 1.5 },
])('rejects invalid deployed read bounds %j', async (change) => {
  await expect(preview(await fixture(), {}, { ...limits, ...change })).rejects.toThrow('bounds')
})
it('honors a pre-aborted caller without reading remote inventories', async () => {
  const f = await fixture(), controller = new AbortController(), reason = new Error('cancel before inspection')
  controller.abort(reason)
  await expect(sharedUsagePreview(f.client, f.root, {}, limits, controller.signal)).rejects.toBe(reason)
  expect(f.calls).toEqual([])
})
it('accepts a live cancellation signal through the complete read and final revalidation', async () => {
  const f = await fixture()
  expect((await sharedUsagePreview(f.client, f.root, {}, limits, new AbortController().signal)).complete).toBe(true)
})
it.each(['next_page', 'second_round'] as const)('cancels the active GET and prevents %s from continuing', async (stage) => {
  const entered = Promise.withResolvers<undefined>(), observedAbort = Promise.withResolvers<undefined>(), controller = new AbortController()
  let assetRounds = 0
  const f = await fixture({ request: async (url, signal) => {
    if (!url.pathname.endsWith('/asset/list')) return
    const page = Number(url.searchParams.get('pageNum'))
    if (page === 1) assetRounds++
    if (!(stage === 'next_page' && page === 2 || stage === 'second_round' && assetRounds === 2)) return
    if (!signal) throw new Error('The real client must pass caller cancellation to its fetch adapter')
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { observedAbort.resolve(undefined); reject(new Error('Fetch request aborted')) }, { once: true })
      entered.resolve(undefined)
    })
  } })
  const pending = sharedUsagePreview(f.client, f.root, {}, limits, controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR', detail: 'request aborted' })
  await entered.promise
  controller.abort(new Error('cancel shared inventory'))
  await observedAbort.promise
  await rejected
  expect(f.calls).toHaveLength(stage === 'next_page' ? 2 : 9)
})
