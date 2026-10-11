/** Read-only centralized reuse planning, preserving cards and rejecting unsafe mappings. */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { reusePreview } from '../src/reuse.ts'
import { character, scene, voice, limits, edit, tree } from './matching-fixture.ts'
import { card, image, mapping, reuseProject, reuseProvider } from './reuse-fixture.ts'
import type { MatchRequirement } from '../src/matching.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function project(reqs?: MatchRequirement[], shots = [mapping()]): Promise<string> {
  const root = await reuseProject(reqs, shots)
  roots.push(root)
  return root
}

it('centralizes character, scene and recognized voice without authorizing any binding', async () => {
  const root = await project(), mock = reuseProvider(), before = await tree(root)
  const result = await reusePreview(mock.client, root, 'requirements.json', undefined, limits)
  expect(result.status).toBe('reuse_ready')
  expect(result.groups.map(group => group.kind)).toEqual(['character', 'scene', 'voice'])
  expect(result.groups.every(group => group.approval_required)).toBe(true)
  expect(result).toMatchObject({ apply_allowed: false, paid_requests: 0, remote_writes: 0, local_writes: 0 })
  expect(await tree(root)).toEqual(before)
  expect(mock.calls.every(call => call.method === 'GET')).toBe(true)
})

it('shares one identity-and-state group across requirements and multiple shots', async () => {
  const root = await project([character, { ...character, id: 'char-2' }], [mapping(), mapping(902, 'char-2')])
  const mock = reuseProvider()
  const result = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.status, JSON.stringify(result)).toBe('reuse_ready')
  expect(result.groups).toHaveLength(1)
  expect(result.groups[0]?.requirement_ids).toEqual(['char-1', 'char-2'])
  expect(result.shots.map(shot => shot.status)).toEqual(['awaiting_confirmation', 'awaiting_confirmation'])
  expect(result.shots.every(shot => !shot.apply_allowed)).toBe(true)
  expect(result.shots[0]?.selections).toEqual([{ material_key: 'lead', asset_id: 11 }, { material_key: 'bg', asset_id: 12 }])
  expect(mock.calls.filter(call => call.method !== 'GET')).toHaveLength(0)
})
it('groups stable-only character requirements and keeps identity namespaces distinct', async () => {
  const stable = { ...character, stable_id: 'lu-office' }
  delete stable.character_id
  const root = await project([stable, { ...stable, id: 'char-2' }, { ...character, id: 'char-3' }])
  const result = await reusePreview(reuseProvider().client, root, 'requirements.json', undefined, limits)
  expect(result.groups).toHaveLength(2)
  expect(result.groups[0]).toMatchObject({ identity: 'lu-office', status: 'reuse_ready', requirement_ids: ['char-1', 'char-2'] })
  expect(result.groups[1]).toMatchObject({ identity: 'lu', status: 'reuse_ready' })
})
it('blocks an image binding aimed at an audio marker instead of declaring the card bound', async () => {
  const shot = mapping()
  const binding = shot.bindings[0]
  if (!binding) throw new Error('Missing fixture binding')
  binding.material_key = 'voice'
  const root = await project([character], [shot]), original = card()
  original.modelConfig = { prompt: '@[阿舟](lead)走进@[大厅](bg)，@[阿舟](voice)' }
  original.storyboardMaterialList = [
    image(11, 'lead', '陆沉舟（职场装）', 'https://example.invalid/lu.png', 1),
    image(12, 'bg', '大厅', 'https://example.invalid/lobby.png', 2),
    { materialKey: 'voice', materialType: 'audio', materialUrl: 'https://example.invalid/lu.wav', sortOrder: 1 },
  ]
  const before = JSON.stringify(original), mock = reuseProvider({ cards: [original] })
  const result = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.shots[0]).toMatchObject({ status: 'blocked', reason_codes: ['IMAGE_MAPPING_TARGETS_AUDIO'], selections: [] })
  expect(result.status).toBe('blocked')
  expect(JSON.stringify(original)).toBe(before)
  expect(mock.calls.every(call => call.method === 'GET')).toBe(true)
})

it('keeps distinct costume or identity-state requirements separate', async () => {
  const root = await project([character, { ...character, id: 'pregnant', state_or_costume: '孕期；便服' }])
  const result = await reusePreview(reuseProvider().client, root, 'requirements.json', undefined, limits)
  expect(result.groups).toHaveLength(2)
  expect(result.groups.map(group => group.status)).toEqual(['reuse_ready', 'needs_review'])
})

it('never merges unverified same-name people into one reusable identity', async () => {
  const req = { ...character }; delete req.character_id
  const root = await project([req, { ...req, id: 'same-name' }])
  const result = await reusePreview(reuseProvider().client, root, 'requirements.json', undefined, limits)
  expect(result.groups).toHaveLength(2)
  expect(result.groups.every(group => group.status === 'needs_review')).toBe(true)
})

it('presents conflicting scene conditions for review, without reading or binding cards', async () => {
  const root = await project([{ ...scene, conditions: ['室外'] }], [mapping(901, 'scene-1')])
  const mock = reuseProvider()
  const result = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.groups[0]?.status).toBe('needs_review')
  expect(result.shots[0]?.reason_codes).toEqual(['RELATION_NOT_REUSE_READY'])
  expect(mock.calls.some(call => call.path.includes('/storyboard/'))).toBe(false)
})

it('keeps missing candidates distinct from incomplete provider reads', async () => {
  const root = await project([{ ...scene, name: '不存在的场景', stable_id: 'unknown' }])
  const absent = await reusePreview(reuseProvider().client, root, 'requirements.json', undefined, limits)
  expect(absent.status).toBe('missing')
  const failed = await reusePreview(reuseProvider({ page: () => { throw new Error('read failed') } }).client, root, 'requirements.json', undefined, limits)
  expect(failed.status).toBe('blocked')
  expect(failed.groups.some(group => group.status === 'missing')).toBe(false)
})

it('blocks incomplete pagination instead of preparing any binding plan', async () => {
  const root = await project()
  const mock = reuseProvider({ page: (_kind, _page, data) => ({ ...data, total: 999 }) })
  const result = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', { ...limits, pageLimit: 1 })
  expect(result.status).toBe('blocked')
  expect(result.shots).toEqual([])
  expect(mock.calls.some(call => call.method !== 'GET')).toBe(false)
})

it('changes fingerprints when asset version evidence changes', async () => {
  const root = await project()
  const first = await reusePreview(reuseProvider().client, root, 'requirements.json', 'reuse.json', limits)
  const changed = await reusePreview(reuseProvider({ parent: (_id, row) => ({ ...row, updateTime: 'version-2' }) }).client, root, 'requirements.json', 'reuse.json', limits)
  expect(changed.fingerprint).not.toBe(first.fingerprint)
  expect(changed.groups[0]?.fingerprint).not.toBe(first.groups[0]?.fingerprint)
  expect(changed.apply_allowed).toBe(false)
})

it('changes fingerprints when the applicable source-backed identity state changes', async () => {
  const root = await project()
  const first = await reusePreview(reuseProvider().client, root, 'requirements.json', undefined, limits)
  await edit(root, 'assets_manifest.json', (document) => { const row = document.items[0]; if (!row) throw new Error('missing fixture'); row.state_or_costume = '孕期；便服' })
  const changed = await reusePreview(reuseProvider().client, root, 'requirements.json', undefined, limits)
  expect(changed.fingerprint).not.toBe(first.fingerprint)
  expect(changed.groups[0]?.status).toBe('needs_review')
})

it('blocks a stale original-source SHA before any card query', async () => {
  const root = await project(), mock = reuseProvider()
  await writeFile(join(root, 'episode.txt'), 'changed source')
  const result = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.status).toBe('blocked')
  expect(mock.calls).toHaveLength(0)
})

it('blocks source changes while reading cards and clears proposed selections', async () => {
  const root = await project()
  const mock = reuseProvider({ onCard: async (_id, row) => { await writeFile(join(root, 'episode.txt'), 'changed during card query'); return row } })
  const result = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.status).toBe('blocked')
  expect(result.shots[0]?.selections).toEqual([])
})

it.each(['approved', 'approval_id', 'confirmation'])('rejects Agent-supplied %s authority in the mapping file', async (key) => {
  const root = await project()
  await writeFile(join(root, 'reuse.json'), JSON.stringify({ version: 1, shots: [mapping()], [key]: true }))
  const result = await reusePreview(reuseProvider().client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.status).toBe('blocked')
  expect(result.issues[0]?.code).toBe('INVALID_REUSE_PLAN')
})

it('preserves unrelated images, reference audio, prompt, model and provider fields', async () => {
  const root = await project(), original = card(), before = JSON.stringify(original)
  const result = await reusePreview(reuseProvider({ cards: [original] }).client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.shots[0]?.status).toBe('awaiting_confirmation')
  expect(result.shots[0]?.before_sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(result.shots[0]?.after_sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(original)).toBe(before)
})

it.each([undefined, 'asset-12', '12'] as const)(
  'safely rejects an unchanged legacy image with non-numeric materialAssetId %s', async (parentId) => {
    const root = await project(), original = card()
    const background: Record<string, unknown> = image(12, 'bg', '大厅', 'https://example.invalid/lobby.png', 2)
    delete background.materialAssetId
    if (parentId !== undefined) background.materialAssetId = parentId
    const materials = original.storyboardMaterialList
    if (!Array.isArray(materials)) throw new Error('Missing fixture materials')
    materials[1] = background
    const before = JSON.stringify(original), filesBefore = await tree(root)
    const mock = reuseProvider({ cards: [original] })
    const result = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', limits)
    expect(result.status).toBe('blocked')
    expect(result.shots[0]).toMatchObject({
      status: 'blocked', reason_codes: ['UNMAPPED_MATERIAL'], selections: [], apply_allowed: false,
    })
    expect(result).toMatchObject({ apply_allowed: false, local_writes: 0, remote_writes: 0, paid_requests: 0 })
    expect(mock.calls.some(call => call.path.includes('/storyboard/'))).toBe(true)
    expect(mock.calls.every(call => call.method === 'GET')).toBe(true)
    expect(JSON.stringify(original)).toBe(before)
    expect(await tree(root)).toEqual(filesBefore)
  },
)

it('blocks plans that would reorder unrelated materials', async () => {
  const root = await project(), original = card()
  original.modelConfig = { prompt: '@[大厅](bg)中@[阿舟](lead)停下。@[声线](voice)' }
  const result = await reusePreview(reuseProvider({ cards: [original] }).client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.shots[0]?.reason_codes).toEqual(['PRESERVATION_CONFLICT'])
})

it('blocks removing an unrelated material no longer present in the prompt', async () => {
  const root = await project(), original = card()
  original.modelConfig = { prompt: '@[阿舟](lead)停下。@[声线](voice)' }
  const result = await reusePreview(reuseProvider({ cards: [original] }).client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.shots[0]?.reason_codes).toEqual(['PRESERVATION_CONFLICT'])
})

it('rejects cross-project and wrong-episode cards', async () => {
  const root = await project()
  for (const [change, code] of [[{ scriptId: 999 }, 'STORYBOARD_PROJECT_MISMATCH'], [{ episodeId: 99 }, 'STORYBOARD_EPISODE_MISMATCH']] as const) {
    const result = await reusePreview(reuseProvider({ cards: [{ ...card(), ...change }] }).client, root, 'requirements.json', 'reuse.json', limits)
    expect(result.shots[0]?.reason_codes).toEqual([code])
  }
})

it('rejects misleading prompt identities even when the material key is correct', async () => {
  const root = await project(), original = card()
  original.modelConfig = { prompt: '@[另一人](lead)走进@[大厅](bg)' }
  const result = await reusePreview(reuseProvider({ cards: [original] }).client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.shots[0]?.reason_codes).toEqual(['PROMPT_IDENTITY_MISMATCH'])
})

it('stops on the first failed card, leaving later cards unqueried and all writes at zero', async () => {
  const root = await project(undefined, [mapping(), mapping(902), mapping(903)])
  const mock = reuseProvider({ onCard: (id, row) => { if (id === 902) throw new Error('partial read failure'); return row } })
  const result = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.shots.map(shot => shot.status)).toEqual(['awaiting_confirmation', 'blocked'])
  expect(result.issues[0]?.code).toBe('PLANNING_STOPPED')
  expect(mock.calls.some(call => call.path.endsWith('/903'))).toBe(false)
  expect(mock.calls.filter(call => call.method !== 'GET')).toHaveLength(0)
  expect(result.apply_allowed).toBe(false)
})

it('returns deterministic fingerprints on repeated previews without applying anything', async () => {
  const root = await project(), mock = reuseProvider(), before = await tree(root)
  const first = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', limits)
  const second = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', limits)
  expect(second).toEqual(first)
  expect(await tree(root)).toEqual(before)
  expect(mock.calls.every(call => call.method === 'GET')).toBe(true)
})

it('cannot use voice requirements to silently replace visual subjects', async () => {
  const root = await project([voice], [mapping(901, 'voice-1')])
  const result = await reusePreview(reuseProvider().client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.groups[0]?.status).toBe('reuse_ready')
  expect(result.shots[0]?.reason_codes).toEqual(['REQUIREMENT_SCOPE_MISMATCH'])
})

it('rejects missing mapping files without inventing empty plans', async () => {
  const root = await project()
  const before = await readFile(join(root, 'assets_manifest.json'), 'utf8')
  const result = await reusePreview(reuseProvider().client, root, 'requirements.json', 'absent.json', limits)
  expect(result.status).toBe('blocked')
  expect(result.issues).not.toHaveLength(0)
  expect(await readFile(join(root, 'assets_manifest.json'), 'utf8')).toBe(before)
})

it('recognizes an already bound card without permitting repeat execution', async () => {
  const root = await project(), original = card()
  const materials = original.storyboardMaterialList
  if (!Array.isArray(materials)) throw new Error('Missing fixture materials')
  materials[0] = { materialKey: 'lead', materialAssetId: 11, assetId: 'asset-11', fileName: '陆沉舟（职场装）',
    materialType: 'image', materialUrl: 'https://example.invalid/lu.png', sortOrder: 1 }
  const mock = reuseProvider({ cards: [original] })
  const result = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.shots[0]?.status).toBe('already_bound')
  expect(result.shots[0]?.apply_allowed).toBe(false)
  expect(mock.calls.every(call => call.method === 'GET')).toBe(true)
})

it('blocks changing asset evidence between reads of one reusable identity', async () => {
  const root = await project([character, { ...character, id: 'repeat' }])
  let version = 0
  const mock = reuseProvider({ parent: (_id, row) => ({ ...row, version: ++version }) })
  const result = await reusePreview(mock.client, root, 'requirements.json', undefined, limits)
  expect(result.status).toBe('blocked')
  expect(result.issues[0]?.code).toBe('ASSET_VERSION_CHANGED')
})

it('blocks a foreign-project candidate before any storyboard plan is inspected', async () => {
  const root = await project()
  const mock = reuseProvider({ parent: (_id, row) => ({ ...row, scriptId: 999 }) })
  const result = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.status).toBe('blocked')
  expect(result.shots).toEqual([])
  expect(mock.calls.some(call => call.path.includes('/storyboard/'))).toBe(false)
})
