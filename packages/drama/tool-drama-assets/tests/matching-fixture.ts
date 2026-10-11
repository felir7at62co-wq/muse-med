/** Offline project and GET-only provider fixtures shared by matching tests. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import type { MatchLimits, MatchRequirement } from '../src/matching.ts'

export const limits: MatchLimits = { pageSize: 1000, pageLimit: 100, requirementsLimit: 100 }
export const source = '阿舟穿职场装走进日间大厅。\n大厅是室内，三个相邻空座清楚可数。\n阿舟：请听我说。'
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const character: MatchRequirement = { id: 'char-1', kind: 'character', name: '阿舟', character_id: 'lu',
  episode: 1, state_or_costume: '非孕期；青年；职场装', source_line: 1, source_text: source.split('\n')[0]!, conditions: ['总裁'] }
export const scene: MatchRequirement = { id: 'scene-1', kind: 'scene', name: '大厅', stable_id: 'lobby',
  episode: 1, source_line: 2, source_text: source.split('\n')[1]!, conditions: ['室内', '日间', '三个相邻空座'] }
export const voice: MatchRequirement = { id: 'voice-1', kind: 'voice', name: '阿舟', character_id: 'lu',
  source_line: 3, source_text: source.split('\n')[2]!, conditions: ['低沉', '普通话'] }

/** Creates only disposable test inputs, never a real project or generation. */
export async function matchingProject(reqs: MatchRequirement[] = [character, scene, voice]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'muse-match-spec-'))
  await mkdir(join(root, 'audio', 'voice-references'), { recursive: true })
  await writeFile(join(root, 'episode.txt'), source)
  await writeFile(join(root, 'voice-source.txt'), 'offline source audio fixture')
  await writeFile(join(root, 'requirements.json'), JSON.stringify({ version: 1, source_path: 'episode.txt', source_sha256: digest(source), requirements: reqs }))
  await writeFile(join(root, 'assets_manifest.json'), JSON.stringify({ script_id: 2708, lead_readonly_records: [], items: [
    { stable_id: 'lu-office', character_id: 'lu', type: 'character', name: '陆沉舟（职场装）', aliases: ['阿舟'],
      identity: '总裁', episodes: [1], state_or_costume: character.state_or_costume, official: true,
      jubian_asset_id: 11, jubian_material_id: 111, url: 'https://example.invalid/lu.png' },
    { stable_id: 'lobby', type: 'scene', name: '大厅', episodes: ['all'], scene_conditions: scene.conditions,
      official: true, jubian_asset_id: 12, jubian_material_id: 112, url: 'https://example.invalid/lobby.png' },
  ] }))
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708, project_bible: { characters: [
    { character_id: 'lu', name: '陆沉舟', aliases: ['阿舟'], asset_id: 11, voice_profile: {
      description: '低沉；普通话', reference_audio: 'https://example.invalid/lu.wav', reference_audio_asset_id: 13,
      reference_audio_sha256: 'a'.repeat(64), reference_audio_duration_seconds: 2 } },
  ] } }))
  await writeFile(join(root, 'audio', 'voice-references', 'manifest.json'), JSON.stringify({ samples: [
    { character_id: 'lu', version: 1, status: 'approved', asset_id: 13, url: 'https://example.invalid/lu.wav',
      sha256: 'a'.repeat(64), duration_seconds: 2, source_path: 'voice-source.txt', source_sha256: digest('offline source audio fixture'), start_seconds: 0 },
  ] }))
  return root
}

interface FixtureDocument {
  [key: string]: unknown
  items: (Record<string, unknown> & { scene_conditions: string[] })[]
  samples: Record<string, unknown>[]
  project_bible: { characters: (Record<string, unknown> & { voice_profile?: Record<string, unknown> })[] }
}

/** Edits one of this helper's authored fixture JSON documents. */
export async function edit(root: string, path: string, change: (document: FixtureDocument) => void): Promise<void> {
  const document = JSON.parse(await readFile(join(root, path), 'utf8')) as FixtureDocument
  change(document)
  await writeFile(join(root, path), JSON.stringify(document))
}

export const assets = [
  { id: 11, scriptId: 2708, assetType: 1, assetName: '陆沉舟（职场装）', delFlag: '0', url: 'https://example.invalid/lu.png' },
  { id: 12, scriptId: 2708, assetType: 2, assetName: '大厅', delFlag: '0', url: 'https://example.invalid/lobby.png' },
  { id: 13, scriptId: 2708, assetType: 4, assetName: '阿舟声线v1', delFlag: '0', assetUrl: 'https://example.invalid/lu.wav' },
]
export const materials = [
  { id: 111, scriptId: 2708, assetId: 11, assetType: 1, isUsed: 1, hsAssetStatus: 'Active', hsAssetId: 'asset-11', assetUrl: assets[0]!.url },
  { id: 112, scriptId: 2708, assetId: 12, assetType: 2, isUsed: 1, hsAssetStatus: 'Active', hsAssetId: 'asset-12', assetUrl: assets[1]!.url },
]

/** Deterministic fetch replacement; any non-GET request fails immediately. */
export function provider(options: {
  assets?: Record<string, unknown>[]
  materials?: Record<string, unknown>[]
  page?: (kind: string, page: number, data: Record<string, unknown>) => unknown
  before?: () => Promise<void>
  parent?: (id: number, value: Record<string, unknown> | undefined) => unknown
} = {}): { fetch: typeof fetch; calls: { method: string; path: string }[]; client: JubianClient } {
  const calls: { method: string; path: string }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? 'GET'
    calls.push({ method, path: url.pathname + url.search })
    if (method !== 'GET') throw new Error('Forbidden paid/write request in matching test')
    await options.before?.()
    let data: unknown
    if (url.pathname.endsWith('/list')) {
      const kind = url.pathname.includes('/material/') ? 'material' : 'asset'
      const list = kind === 'asset' ? options.assets ?? assets : options.materials ?? materials
      const page = Number(url.searchParams.get('pageNum'))
      const size = Number(url.searchParams.get('pageSize'))
      const body = { total: list.length, rows: list.slice((page - 1) * size, page * size) }
      data = options.page ? options.page(kind, page, body) : body
    } else {
      const id = Number(url.pathname.split('/').at(-1))
      const value = (options.assets ?? assets).find(row => row.id === id)
      data = options.parent ? options.parent(id, value) : value
    }
    return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
  }
  return { fetch: fetcher, calls, client: new JubianClient({ credential: async () => 'offline-test-token', fetch: fetcher }) }
}

/** Complete file bytes before/after calls demonstrate no local side effects. */
export async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) for (const [name, digest] of Object.entries(await tree(join(root, entry.name)))) result[`${entry.name}/${name}`] = digest
    else result[entry.name] = createHash('sha256').update(await readFile(join(root, entry.name))).digest('hex')
  }
  return result
}
