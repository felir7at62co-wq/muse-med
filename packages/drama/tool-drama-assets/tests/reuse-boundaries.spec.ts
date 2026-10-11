/** External mapping and card JSON must preserve every requested binding and unrelated material. */
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { reusePreview } from '../src/reuse.ts'
import { character, digest, edit, limits, source } from './matching-fixture.ts'
import { card, mapping, reuseProject, reuseProvider } from './reuse-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function project() { const root = await reuseProject([character]); roots.push(root); return root }

it.each([null, [], { version: 1, shots: [null] }, { version: 1, shots: [mapping(), mapping()] },
  { version: 1, shots: [{ ...mapping(), bindings: [null] }] },
  { version: 1, shots: [{ ...mapping(), bindings: [{ requirement_id: 'char-1', material_key: 'lead', approval: true }] }] },
  { version: 1, shots: [{ ...mapping(), bindings: [{ requirement_id: 'char-1', material_key: 'lead' }, { requirement_id: 'char-1', material_key: 'lead' }] }] },
])('blocks malformed or ambiguous mappings %j', async (value) => {
  const root = await project(), mock = reuseProvider()
  await writeFile(join(root, 'reuse.json'), JSON.stringify(value))
  const result = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.status).toBe('blocked'); expect(result.shots).toEqual([])
  expect(mock.calls.some(call => call.path.includes('/storyboard/'))).toBe(false)
})
it.each(['prompt-type', 'materials-type', 'unknown-material', 'duplicate-key', 'unknown-prompt-name'])('rejects invalid %s card data', async (kind) => {
  const root = await project(), board = card()
  if (kind === 'prompt-type') board.modelConfig = { prompt: null }
  else if (kind === 'materials-type') board.storyboardMaterialList = {}
  else if (kind === 'unknown-material') board.storyboardMaterialList = [{ materialKey: 'lead', materialType: 'video' }]
  else if (kind === 'duplicate-key') board.storyboardMaterialList = [
    { materialKey: 'lead', materialType: 'image' }, { materialKey: 'lead', materialType: 'audio' },
  ]
  else board.modelConfig = { prompt: '@[未知角色](lead)' }
  const result = await reusePreview(reuseProvider({ cards: [board] }).client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.shots[0]?.status).toBe('blocked'); expect(result.shots[0]?.selections).toEqual([])
})
it('reads serialized provider cards without changing their unrelated fields', async () => {
  const root = await project(), board = card()
  board.modelConfig = JSON.stringify(board.modelConfig)
  board.storyboardMaterialList = JSON.stringify(board.storyboardMaterialList)
  const before = JSON.stringify(board)
  const result = await reusePreview(reuseProvider({ cards: [board] }).client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.shots[0]?.status).toBe('awaiting_confirmation')
  expect(JSON.stringify(board)).toBe(before)
})
it('groups repeated character requirements without inventing episode coverage', async () => {
  const root = await project()
  const req = { ...character }; delete req.episode
  await writeFile(join(root, 'requirements.json'), JSON.stringify({ version: 1, source_path: 'episode.txt',
    source_sha256: digest(source),
    requirements: [req, { ...req, id: 'repeat' }] }))
  const result = await reusePreview(reuseProvider().client, root, 'requirements.json', undefined, limits)
  expect(result.groups).toHaveLength(1); expect(result.groups[0]?.episodes).toEqual([])
})
it('retains every distinct episode in a shared character reuse group', async () => {
  const root = await project()
  await edit(root, 'assets_manifest.json', (doc) => { doc.items[0]!.episodes = [1, 2] })
  await edit(root, 'requirements.json', (doc) => { doc.requirements = [character, { ...character, id: 'char-2', episode: 2 }] })
  const result = await reusePreview(reuseProvider().client, root, 'requirements.json', undefined, limits)
  expect(result.groups).toHaveLength(1); expect(result.groups[0]?.episodes).toEqual([1, 2])
})
it('uses the requirement name when a registered asset has no aliases', async () => {
  const root = await project()
  await edit(root, 'assets_manifest.json', (doc) => { doc.items[0]!.name = character.name; delete doc.items[0]!.aliases })
  const result = await reusePreview(reuseProvider().client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.shots[0]?.status).toBe('awaiting_confirmation')
})
it('blocks an individual parent failure without inspecting or authorizing any card', async () => {
  const root = await project()
  const mock = reuseProvider({ parent: (_id, row) => ({ ...row, url: 'https://example.invalid/changed.png' }) })
  const result = await reusePreview(mock.client, root, 'requirements.json', 'reuse.json', limits)
  expect(result.status).toBe('blocked'); expect(result.issues).toEqual([]); expect(result.shots).toEqual([])
})
it('returns a non-authorizing fingerprint when requirements cannot be read', async () => {
  const root = await project(), mock = reuseProvider()
  await writeFile(join(root, 'requirements.json'), 'null')
  const result = await reusePreview(mock.client, root, 'requirements.json', undefined, limits)
  expect(result.status).toBe('blocked'); expect(result.groups).toEqual([]); expect(mock.calls).toEqual([])
  expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/)
})
