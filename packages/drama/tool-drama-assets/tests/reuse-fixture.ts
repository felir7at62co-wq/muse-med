/** Disposable reuse-plan projects and GET-only storyboard fixtures. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import { matchingProject, provider, materials } from './matching-fixture.ts'
import type { MatchRequirement } from '../src/matching.ts'

export const mapping = (id = 901, requirement = 'char-1') => ({ storyboard_id: id, episode: 1, episode_id: 91,
  bindings: [{ requirement_id: requirement, material_key: 'lead' }] })

export const image = (id: number, key: string, name: string, url: string, order: number) => ({
  materialKey: key, materialAssetId: id, assetId: `asset-${id}`, fileName: name, materialType: 'image',
  materialUrl: url, sortOrder: order,
})

export const card = (id = 901): Record<string, unknown> => ({ id, scriptId: 2708, episodeId: 91,
  duration: 5000, privateProviderField: { retained: true },
  modelConfig: { prompt: '@[阿舟](lead)走进@[大厅](bg)，@[阿舟](lead)停下。@[声线](voice)', platformName: 'fixture', resolution: '720p' },
  storyboardMaterialList: [image(99, 'lead', '旧选择', 'https://example.invalid/old.png', 1),
    image(12, 'bg', '大厅', 'https://example.invalid/lobby.png', 2),
    { materialKey: 'voice', materialType: 'audio', materialUrl: 'https://example.invalid/lu.wav', sortOrder: 1 }],
})

/** Builds one disposable project with source-backed requirements and explicit card mapping. */
export async function reuseProject(reqs?: MatchRequirement[], shots = [mapping()]): Promise<string> {
  const root = await matchingProject(reqs)
  await writeFile(join(root, 'reuse.json'), JSON.stringify({ version: 1, shots }))
  return root
}

/** Only simulated GET is reachable; no execution or paid method exists. */
export function reuseProvider(options: Parameters<typeof provider>[0] & {
  cards?: Record<string, unknown>[]
  onCard?: (id: number, row: Record<string, unknown> | undefined) => unknown
} = {}) {
  const mock = provider({ ...options, materials: options.materials ?? materials.map(row => ({ ...row,
    assetName: row.assetId === 11 ? '陆沉舟（职场装）' : '大厅' })) })
  const calls: { method: string; path: string }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    calls.push({ method: init?.method ?? 'GET', path: url.pathname + url.search })
    if ((init?.method ?? 'GET') !== 'GET') throw new Error('No writes allowed')
    if (!url.pathname.includes('/aigc/storyboard/')) return await mock.fetch(input, init)
    const id = Number(url.pathname.split('/').at(-1))
    const value = (options.cards ?? [card(901), card(902), card(903)]).find(row => row.id === id)
    const data = options.onCard ? await options.onCard(id, value) : value
    return new Response(JSON.stringify({ code: 200, data }), { status: 200 })
  }
  return { calls, fetch: fetcher, client: new JubianClient({ credential: async () => 'offline-test-token', fetch: fetcher }) }
}
