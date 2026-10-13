/** Current-file usage projection and voice gaps; no remote writes or automatic approvals. */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { usagePreview } from '../src/usage.ts'
import { digest, edit, matchingProject, provider, tree } from './matching-fixture.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(): Promise<string> {
  const root = await matchingProject()
  roots.push(root)
  const bindings = [
    { material_key: 'person', name: '陆沉舟（职场装）', type: '角色', official: true, asset_id: '11', material_id: '111', url: 'https://example.invalid/lu.png' },
    { material_key: 'room', name: '大厅', type: 'scene', official: true, asset_id: '12', material_id: '112', url: 'https://example.invalid/lobby.png' },
  ]
  await writeFile(join(root, 'compiled.json'), JSON.stringify({ method: 'compile', ok: true,
    shots: [{ shot: 1, bindings }, { shot: 2, bindings: [bindings[1]] }],
    packages: [{ index: 1, shots: [1, 2], material_bindings: bindings }] }))
  await index(root)
  return root
}
async function index(root: string): Promise<void> {
  await writeFile(join(root, 'usage.json'), JSON.stringify({ version: 1, documents: [{ path: 'compiled.json', sha256: digest(await readFile(join(root, 'compiled.json'), 'utf8')), episode: 54 }] }))
}
it('reports exact version, package and shots without claiming remote binding', async () => {
  const root = await fixture(), before = await tree(root), remote = provider()
  const result = await usagePreview(remote.client, root, 'usage.json', undefined, 100)
  expect(result.usage_rows).toMatchObject([
    { kind: 'voice', asset_id: 13, status: 'project_voice_reference' },
    { stable_id: 'lu-office', character_id: 'lu', asset_id: 11, material_id: 111, episode: 54, package_index: 1, shots: [1], status: 'local_package_reference' },
    { stable_id: 'lobby', asset_id: 12, shots: [1, 2] },
  ])
  expect(result.voice_states).toEqual([{ character_id: 'lu', name: '陆沉舟', candidate_count: 0, status: 'current_reference_needs_verification' }])
  expect(result.issues).toEqual([])
  expect(remote.calls).toEqual([])
  expect(await tree(root)).toEqual(before)
})
it('queries an exact asset and reports a truncated global view honestly', async () => {
  const root = await fixture(), remote = provider()
  expect((await usagePreview(remote.client, root, 'usage.json', 11, 1)).usage_rows).toHaveLength(1)
  const limited = await usagePreview(remote.client, root, 'usage.json', undefined, 1)
  expect(limited).toMatchObject({ total: 3, truncated: true })
})
it('re-reads newly added and changed material versions instead of caching names', async () => {
  const root = await fixture(), remote = provider()
  await edit(root, 'assets_manifest.json', (doc) => { doc.items[0]!.jubian_material_id = 222 })
  expect((await usagePreview(remote.client, root, 'usage.json', 11, 100)).issues[0]?.code).toBe('ASSET_VERSION_CHANGED')
  await edit(root, 'compiled.json', (doc) => {
    const packages = doc.packages as { material_bindings: { material_id: string }[] }[]
    const shots = doc.shots as { bindings: { material_id: string }[] }[]
    packages[0]!.material_bindings[0]!.material_id = '222'
    shots[0]!.bindings[0]!.material_id = '222'
  })
  await index(root)
  expect((await usagePreview(remote.client, root, 'usage.json', 11, 100)).usage_rows[0]?.material_id).toBe(222)
})
it('distinguishes missing voices from candidates and never promotes candidate samples', async () => {
  const root = await fixture()
  await edit(root, 'project_config.json', (doc) => { delete doc.project_bible.characters[0]!.voice_profile })
  expect((await usagePreview(provider().client, root, undefined, undefined, 100)).voice_states[0]?.status).toBe('missing')
  await edit(root, 'audio/voice-references/manifest.json', (doc) => { doc.samples[0]!.status = 'candidate' })
  expect((await usagePreview(provider().client, root, undefined, undefined, 100)).voice_states[0]?.status).toBe('candidate')
})
it('reports current and missing voices separately for each period and excludes archived and untagged candidates', async () => {
  const root = await fixture()
  await edit(root, 'project_config.json', (doc) => {
    const row = doc.project_bible.characters[0]
    if (!row) throw new Error('Missing character fixture')
    row.voice_profiles = [{ ...row.voice_profile, voice_period_id: 'adult', label: '成年' },
      { voice_period_id: 'child', description: '童声' }, { voice_period_id: 'elder', label: '老年', description: '低哑' }]
  })
  await edit(root, 'audio/voice-references/manifest.json', (doc) => {
    doc.samples = [{ character_id: 'lu', voice_period_id: 'child', status: 'candidate' },
      { character_id: 'lu', voice_period_id: 'child', status: 'archived_duplicate' },
      { character_id: 'lu', voice_period_id: 'elder', status: 'archived' },
      { character_id: 'lu', status: 'candidate' }]
  })
  const result = await usagePreview(provider().client, root, undefined, undefined, 100)
  expect(result.voice_states).toEqual([
    { character_id: 'lu', name: '陆沉舟', voice_period_id: 'adult', voice_period_label: '成年',
      status: 'current_reference_needs_verification', candidate_count: 0 },
    { character_id: 'lu', name: '陆沉舟', voice_period_id: 'child', status: 'candidate', candidate_count: 1 },
    { character_id: 'lu', name: '陆沉舟', voice_period_id: 'elder', voice_period_label: '老年', status: 'missing', candidate_count: 0 },
  ])
  expect(result.usage_rows).toHaveLength(1)
  expect(result.usage_rows[0]).toMatchObject({ asset_id: 13, voice_period_id: 'adult', voice_period_label: '成年' })
})
it('reports the precise period with an unregistered reference and refuses an overflowing period inventory', async () => {
  const root = await fixture()
  await edit(root, 'project_config.json', (doc) => {
    const row = doc.project_bible.characters[0]
    if (!row) throw new Error('Missing character fixture')
    row.voice_profiles = [{ voice_period_id: 'child', description: '童声', reference_audio: 'https://example.invalid/child.wav' },
      { ...row.voice_profile, voice_period_id: 'adult' }]
  })
  const result = await usagePreview(provider().client, root, undefined, undefined, 100)
  expect(result.issues[0]).toEqual({ code: 'VOICE_ID_MISSING', message: 'lu/child: reference has no verified parent ID' })
  await expect(usagePreview(provider().client, root, undefined, undefined, 1)).rejects.toThrow('bounded voice periods')
})
it('retains an empty legacy voice with no added period fields', async () => {
  const root = await fixture()
  await edit(root, 'project_config.json', (doc) => {
    const row = doc.project_bible.characters[0]
    if (!row) throw new Error('Missing character fixture')
    delete row.voice_profile; row.voice_profiles = []
  })
  const result = await usagePreview(provider().client, root, undefined, undefined, 100)
  expect(result.voice_states).toEqual([{ character_id: 'lu', name: '陆沉舟', status: 'missing', candidate_count: 0 }])
})
it('refuses stale output fingerprints, duplicate keys and foreign project data', async () => {
  const root = await fixture()
  await writeFile(join(root, 'compiled.json'), '{}')
  await expect(usagePreview(provider().client, root, 'usage.json', undefined, 100)).rejects.toThrow('changed')
  const another = await fixture()
  await edit(another, 'compiled.json', (doc) => { const packages = doc.packages as { material_bindings: { material_key: string }[] }[]; packages[0]!.material_bindings[1]!.material_key = 'person' })
  await index(another)
  await expect(usagePreview(provider().client, another, 'usage.json', undefined, 100)).rejects.toThrow('unique')
  await edit(another, 'project_config.json', (doc) => { doc.jubian_script_id = 999 })
  await expect(usagePreview(provider().client, another, undefined, undefined, 100)).rejects.toThrow('same script')
})

it('keeps local asset-use queries available when a legacy project has no voice bible', async () => {
  const root = await fixture()
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  const result = await usagePreview(provider().client, root, 'usage.json', undefined, 100)
  expect(result.usage_rows).toHaveLength(2)
  expect(result.voice_states).toEqual([])
  expect(result.issues[0]?.code).toBe('VOICE_IDENTITY_NOT_CONFIGURED')
})

it('refuses contradictory shot identities and reports package-only references without inventing shot uses', async () => {
  const root = await fixture()
  await edit(root, 'compiled.json', (doc) => {
    const shots = doc.shots as { bindings: { name: string }[] }[]
    shots[0]!.bindings[0]!.name = '另一个人物'
  })
  await index(root)
  await expect(usagePreview(provider().client, root, 'usage.json', undefined, 100)).rejects.toThrow('identities disagree')
  const another = await fixture()
  await edit(another, 'compiled.json', (doc) => {
    const shots = doc.shots as { bindings: { asset_id: string }[] }[]
    for (const shot of shots) shot.bindings = shot.bindings.filter(binding => binding.asset_id !== '11')
  })
  await index(another)
  const result = await usagePreview(provider().client, another, 'usage.json', 11, 100)
  expect(result.usage_rows).toEqual([])
  expect(result.issues[0]?.code).toBe('PACKAGE_ASSET_NOT_IN_SHOTS')
})

it.each([-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses an invalid exact parent ID %s', async (assetId) => {
  await expect(usagePreview(provider().client, await fixture(), undefined, assetId, 100)).rejects.toThrow('positive asset_id')
})

it('keeps missing voice ledgers optional and reports manifest diagnostics without inventing uses', async () => {
  const root = await fixture()
  await rm(join(root, 'audio/voice-references/manifest.json'))
  await edit(root, 'assets_manifest.json', (doc) => { delete doc.lead_readonly_records })
  const result = await usagePreview(provider().client, root, 'usage.json', undefined, 100)
  expect(result.issues).not.toEqual([])
  expect(result.usage_rows).toHaveLength(3)
})

it.each([
  ['null project', 'project_config.json', null],
  ['array project', 'project_config.json', []],
  ['primitive bible', 'project_config.json', { jubian_script_id: 2708, project_bible: 'unknown' }],
  ['missing characters', 'project_config.json', { jubian_script_id: 2708, project_bible: {} }],
  ['characters overflow', 'project_config.json', { jubian_script_id: 2708, project_bible: { characters: Array(101).fill({ character_id: 'lu' }) } }],
  ['foreign voice ledger', 'audio/voice-references/manifest.json', { script_id: 2709, samples: [] }],
  ['no samples array', 'audio/voice-references/manifest.json', { script_id: 2708, samples: {} }],
  ['null voice record', 'audio/voice-references/manifest.json', { samples: [null] }],
  ['unknown plan version', 'usage.json', { version: 2, documents: [] }],
  ['no documents array', 'usage.json', { version: 1, documents: {} }],
  ['documents overflow', 'usage.json', { version: 1, documents: Array(101).fill({}) }],
  ['missing document path', 'usage.json', { version: 1, documents: [{ episode: 54, sha256: 'a'.repeat(64) }] }],
  ['non-numeric episode', 'usage.json', { version: 1, documents: [{ path: 'compiled.json', episode: false, sha256: 'a'.repeat(64) }] }],
  ['malformed episode string', 'usage.json', { version: 1, documents: [{ path: 'compiled.json', episode: '54a', sha256: 'a'.repeat(64) }] }],
  ['invalid source fingerprint', 'usage.json', { version: 1, documents: [{ path: 'compiled.json', episode: 54, sha256: 'invalid' }] }],
] as const)('refuses %s in current durable input', async (_name, path, value) => {
  const root = await fixture()
  await writeFile(join(root, path), JSON.stringify(value))
  await expect(usagePreview(provider().client, root, 'usage.json', undefined, 100)).rejects.toThrow()
})

it.each(['missing', 'duplicate'] as const)('refuses %s character identity', async (mode) => {
  const root = await fixture()
  await edit(root, 'project_config.json', (doc) => {
    if (mode === 'missing') delete doc.project_bible.characters[0]!.character_id
    else doc.project_bible.characters.push({ ...doc.project_bible.characters[0]! })
  })
  await expect(usagePreview(provider().client, root, undefined, undefined, 100)).rejects.toThrow('unique stable character_id')
})

it('reports an unregistered voice parent and retains candidate counts only for its stable character', async () => {
  const root = await fixture()
  await edit(root, 'project_config.json', (doc) => { delete doc.project_bible.characters[0]!.voice_profile!.reference_audio_asset_id })
  await edit(root, 'audio/voice-references/manifest.json', (doc) => { doc.samples.push({ character_id: 'other', status: 'candidate' }) })
  const result = await usagePreview(provider().client, root, undefined, undefined, 100)
  expect(result.usage_rows).toEqual([])
  expect(result.issues[0]?.code).toBe('VOICE_ID_MISSING')
  expect(result.voice_states[0]?.candidate_count).toBe(0)
})

type Binding = { material_key: string; name: string; type: string; official: boolean; asset_id: string; material_id: string; url: string }
type CompilerFixture = {
  method: string
  ok: boolean
  shots: { shot: number; bindings: Binding[] }[]
  packages: { index: number; shots: number[]; material_bindings: Binding[] }[]
}
async function compilerEdit(root: string, change: (document: CompilerFixture) => void): Promise<void> {
  const document = JSON.parse(await readFile(join(root, 'compiled.json'), 'utf8')) as CompilerFixture
  change(document)
  await writeFile(join(root, 'compiled.json'), JSON.stringify(document))
  await index(root)
}
it.each([
  ['non-compile result', (doc: CompilerFixture) => { doc.method = 'preview' }],
  ['failed compilation', (doc: CompilerFixture) => { doc.ok = false }],
  ['invalid shot ID', (doc: CompilerFixture) => { doc.shots[0]!.shot = 0 }],
  ['duplicate shot ID', (doc: CompilerFixture) => { doc.shots.push(doc.shots[0]!) }],
  ['invalid package ID', (doc: CompilerFixture) => { doc.packages[0]!.index = 0 }],
  ['invalid package shot', (doc: CompilerFixture) => { doc.packages[0]!.shots = [0] }],
  ['nonexistent package shot', (doc: CompilerFixture) => { doc.packages[0]!.shots.push(99) }],
  ['non-numeric parent ID', (doc: CompilerFixture) => { doc.packages[0]!.material_bindings[0]!.asset_id = 'unknown' }],
  ['non-numeric material ID', (doc: CompilerFixture) => { doc.packages[0]!.material_bindings[0]!.material_id = 'unknown' }],
  ['missing material key', (doc: CompilerFixture) => { doc.packages[0]!.material_bindings[0]!.material_key = '' }],
  ['duplicate shot binding', (doc: CompilerFixture) => { doc.shots[0]!.bindings.push(doc.shots[0]!.bindings[0]!) }],
  ['unofficial shot reference', (doc: CompilerFixture) => { doc.shots[0]!.bindings[0]!.official = false }],
  ['wrong shot category', (doc: CompilerFixture) => { doc.shots[0]!.bindings[0]!.type = 'scene' }],
  ['wrong shot URL', (doc: CompilerFixture) => { doc.shots[0]!.bindings[0]!.url = 'https://example.invalid/other.png' }],
] as const)('refuses %s rather than guessing an asset use', async (_name, change) => {
  const root = await fixture()
  await compilerEdit(root, change)
  await expect(usagePreview(provider().client, root, 'usage.json', undefined, 100)).rejects.toThrow()
})

it.each([
  { method: 'compile', ok: true, shots: [] },
  { method: 'compile', ok: true, packages: [] },
  { method: 'compile', ok: true, packages: [], shots: [{ shot: 1, bindings: {} }] },
  { method: 'compile', ok: true, shots: [], packages: [{ index: 1, shots: {} }] },
  { method: 'compile', ok: true, shots: [], packages: [{ index: 1, shots: [], material_bindings: {} }] },
])('refuses incomplete compiler arrays %#', async (document) => {
  const root = await fixture()
  await writeFile(join(root, 'compiled.json'), JSON.stringify(document))
  await index(root)
  await expect(usagePreview(provider().client, root, 'usage.json', undefined, 100)).rejects.toThrow()
})

it('reports changed categories and preserves exact prop identity when a new asset replaces a scene', async () => {
  const root = await fixture()
  await edit(root, 'assets_manifest.json', (doc) => { doc.items[1]!.type = 'unknown' })
  expect((await usagePreview(provider().client, root, 'usage.json', 12, 100)).issues[0]?.code).toBe('ASSET_VERSION_CHANGED')
  await edit(root, 'assets_manifest.json', (doc) => { doc.items[1]!.type = 'prop' })
  await compilerEdit(root, (doc) => {
    doc.packages[0]!.material_bindings[1]!.type = '道具'
    for (const shot of doc.shots) for (const binding of shot.bindings) if (binding.asset_id === '12') binding.type = 'prop'
  })
  expect((await usagePreview(provider().client, root, 'usage.json', 12, 100)).usage_rows[0]).toMatchObject({ kind: 'prop', shots: [1, 2] })
})
