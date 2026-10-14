/** Identity, uncertainty, source integrity and read-only matching regressions. */
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { matchPreview } from '../src/matching.ts'
import type { MatchRequirement } from '../src/matching.ts'
import { assets, character, digest, edit, limits, matchingProject, provider, scene, source, tree, voice } from './matching-fixture.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function project(reqs?: MatchRequirement[]): Promise<string> {
  const root = await matchingProject(reqs)
  roots.push(root)
  return root
}
function fixtureRow<T>(rows: readonly T[], index = 0): T {
  const row = rows[index]
  if (row === undefined) throw new Error(`Expected fixture row ${index}`)
  return row
}
async function preview(root: string, options: Parameters<typeof provider>[0] = {}, bounds = limits) {
  const mock = provider(options), before = await tree(root)
  const result = await matchPreview(mock.client, root, 'requirements.json', bounds)
  expect(mock.calls.every(call => call.method === 'GET')).toBe(true)
  expect(result).toMatchObject({ read_only: true, paid_requests: 0, remote_writes: 0, local_writes: 0, search_scope: 'current_project' })
  if (!options.before) expect(await tree(root)).toEqual(before)
  return { result, calls: mock.calls }
}

it('prepares verified character, scene and approved voice reuse without writing or generating', async () => {
  const { result } = await preview(await project())
  expect(result.counts).toEqual({ reuse_ready: 3, needs_review: 0, missing: 0, blocked: 0 })
  expect(result.matches.map(row => row.selected_asset_id)).toEqual([11, 12, 13])
})
it('resolves the confirmed character alias across an explicit episode and costume', async () => {
  expect((await preview(await project([character]))).result.matches[0]?.status).toBe('reuse_ready')
})
it('accepts stable identity alone and consistent character-and-stable identities', async () => {
  const stableOnly = { ...character, stable_id: 'lu-office' }
  delete stableOnly.character_id
  for (const requirement of [stableOnly, { ...character, stable_id: 'lu-office' }]) {
    expect((await preview(await project([requirement]))).result.matches[0]?.status).toBe('reuse_ready')
  }
})
it.each(['another-person', 'unknown-person'])('rejects stable identity conflicting with character %s', async (characterId) => {
  const root = await project([{ ...character, character_id: characterId, stable_id: 'lu-office' }])
  await edit(root, 'project_config.json', (doc) => {
    doc.project_bible.characters.push({ character_id: 'another-person', name: '阿舟', asset_id: 14 })
  })
  const { result, calls } = await preview(root)
  expect(result.matches[0]).toMatchObject({ status: 'needs_review', reason_codes: ['IDENTITY_FIELDS_CONFLICT'] })
  expect(calls.some(call => call.path.endsWith('/asset/11'))).toBe(false)
})
it('rejects an explicit stable id that contradicts the registered character', async () => {
  const { result } = await preview(await project([{ ...character, stable_id: 'another-stable-id' }]))
  expect(result.matches[0]?.reason_codes).toEqual(['IDENTITY_FIELDS_CONFLICT'])
})
it('rejects a manifest character id that contradicts its parent asset identity', async () => {
  const root = await project([character])
  await edit(root, 'assets_manifest.json', (doc) => { fixtureRow(doc.items).character_id = 'another-person' })
  expect((await preview(root)).result.matches[0]?.reason_codes).toEqual(['IDENTITY_FIELDS_CONFLICT'])
})
it('rejects a project-bible asset that contradicts the manifest character identity', async () => {
  const root = await project([character])
  await edit(root, 'project_config.json', (doc) => { fixtureRow(doc.project_bible.characters).asset_id = 14 })
  expect((await preview(root)).result.matches[0]?.reason_codes).toEqual(['IDENTITY_FIELDS_CONFLICT'])
})
it('reuses a registered costume version whose character shares a different reference asset', async () => {
  const root = await project([{ ...character, stable_id: 'lu-office' }])
  await edit(root, 'assets_manifest.json', (doc) => {
    doc.items.push({ ...fixtureRow(doc.items), stable_id: 'lu-home', jubian_asset_id: 14,
      state_or_costume: '非孕期；青年；家常装' })
  })
  await edit(root, 'project_config.json', (doc) => { fixtureRow(doc.project_bible.characters).asset_id = 14 })
  const reference = { ...fixtureRow(assets), id: 14 }
  expect((await preview(root, { assets: [...assets, reference] })).result.matches[0])
    .toMatchObject({ status: 'reuse_ready', selected_asset_id: 11 })
})
it('does not identify a character by matching name alone', async () => {
  const requirement = { ...character }
  delete requirement.character_id
  const root = await project([requirement])
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('NAME_ONLY_IDENTITY_UNVERIFIED')
})
it('does not use an explicit stable id to override a conflicting character name', async () => {
  const root = await project([{ ...character, name: '另一个人', stable_id: 'lu-office' }])
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('IDENTITY_NAME_CONFLICT')
})
it('does not reuse the wrong costume', async () => {
  const root = await project([{ ...character, state_or_costume: '非孕期；青年；家常装' }])
  expect((await preview(root)).result.matches[0]?.status).toBe('needs_review')
})
it('does not reuse a version outside its episode coverage', async () => {
  const root = await project([{ ...character, episode: 2 }])
  expect((await preview(root)).result.matches[0]?.status).toBe('needs_review')
})
it('does not guess among multiple registered matching versions', async () => {
  const root = await project([character])
  await edit(root, 'assets_manifest.json', (doc) => { doc.items.push({ ...fixtureRow(doc.items), jubian_asset_id: 14 }) })
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('AMBIGUOUS_CANDIDATES')
})
it('keeps unconfirmed pictures as review candidates', async () => {
  const root = await project([character]); await edit(root, 'assets_manifest.json', (doc) => { fixtureRow(doc.items).official = false })
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('FORMAL_ASSET_EVIDENCE_MISSING')
})
it('does not treat a generic scene as proof of its required seats', async () => {
  const root = await project([scene]); await edit(root, 'assets_manifest.json', (doc) => { fixtureRow(doc.items, 1).scene_conditions = ['室内', '日间'] })
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('STATE_OR_CONDITIONS_CONFLICT')
})
it('does not treat a negated scene condition as a positive match', async () => {
  const root = await project([scene]); await edit(root, 'assets_manifest.json', (doc) => { fixtureRow(doc.items, 1).scene_conditions[2] = '没有三个相邻空座' })
  expect((await preview(root)).result.matches[0]?.status).toBe('needs_review')
})
it('requires scene identity evidence rather than only its name', async () => {
  const requirement = { ...scene }
  delete requirement.stable_id
  const root = await project([requirement])
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('NAME_ONLY_IDENTITY_UNVERIFIED')
})
it('requires explicit scene conditions before recommending reuse', async () => {
  const root = await project([{ ...scene, conditions: [] }])
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('REQUIREMENT_DETAILS_MISSING')
})
it('lists an unregistered current-project name match for review instead of buying it again', async () => {
  const root = await project([scene]); await edit(root, 'assets_manifest.json', (doc) => { doc.items = [] })
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('UNREGISTERED_CANDIDATE')
})
it('reports missing only after complete current-project reads', async () => {
  const root = await project([scene]); await edit(root, 'assets_manifest.json', (doc) => { doc.items = [] })
  const { result } = await preview(root, { assets: [], materials: [] })
  expect(result.status).toBe('missing'); expect(result.next).toContain('既有素材库检索')
})
it('blocks changed registered image URLs', async () => {
  const root = await project([character]); await edit(root, 'assets_manifest.json', (doc) => { fixtureRow(doc.items).url = 'https://example.invalid/new.png' })
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('ASSET_SOURCE_CHANGED')
})
it('blocks mismatched asset detail identity', async () => {
  const root = await project([character])
  expect((await preview(root, { parent: (_id, row) => ({ ...row, scriptId: 999 }) })).result.matches[0]?.status).toBe('blocked')
})
it('blocks deleted or inactive formal assets', async () => {
  const root = await project([character])
  expect((await preview(root, { assets: assets.map(row => ({ ...row, delFlag: '1' })) })).result.matches[0]?.status).toBe('blocked')
})
it('does not replace an approved voice with a newly named candidate', async () => {
  const root = await project([voice]); await edit(root, 'audio/voice-references/manifest.json', (doc) => { fixtureRow(doc.samples).status = 'candidate' })
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('VOICE_APPROVAL_OR_SOURCE_UNVERIFIED')
})
it('requires the voice character identity', async () => {
  const requirement = { ...voice }
  delete requirement.character_id
  const root = await project([requirement])
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('CHARACTER_VOICE_IDENTITY_UNVERIFIED')
})
it('does not trust approved voice metadata without an actual source', async () => {
  const root = await project([voice]); await edit(root, 'audio/voice-references/manifest.json', (doc) => { delete fixtureRow(doc.samples).source_path })
  expect((await preview(root)).result.matches[0]?.status).toBe('needs_review')
})
it('blocks voice reference hash or URL changes', async () => {
  const root = await project([voice]); await edit(root, 'project_config.json', (doc) => { fixtureRow(doc.project_bible.characters).voice_profile!.reference_audio_sha256 = 'b'.repeat(64) })
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('VOICE_REFERENCE_CHANGED')
})
it('blocks changes to the original voice source', async () => {
  const root = await project([voice]); await writeFile(join(root, 'voice-source.txt'), 'changed source')
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('VOICE_SOURCE_CHANGED')
})
it('matches a configured voice period without falling back to another period or the legacy voice', async () => {
  const root = await project([{ ...voice, voice_period_id: 'adult' }])
  await edit(root, 'project_config.json', (doc) => {
    const row = fixtureRow(doc.project_bible.characters)
    row.voice_profiles = [{ voice_period_id: 'child', label: '童年', description: '童声' },
      { ...row.voice_profile, voice_period_id: 'adult', label: '成年' }]
  })
  await edit(root, 'audio/voice-references/manifest.json', (doc) => { fixtureRow(doc.samples).voice_period_id = 'adult' })
  const result = (await preview(root)).result
  expect(result.matches[0]).toMatchObject({ status: 'reuse_ready', voice_period_id: 'adult', selected_asset_id: 13 })
  expect(result.matches[0]?.evidence).toContain('voice_period_id=adult')
  await edit(root, 'requirements.json', (doc) => {
    doc.requirements = [{ ...voice, voice_period_id: 'child' }]
  })
  expect((await preview(root)).result.matches[0]?.status).toBe('needs_review')
  await edit(root, 'requirements.json', (doc) => { doc.requirements = [{ ...voice, voice_period_id: 'elder' }] })
  expect((await preview(root)).result.matches[0]?.reason_codes).toEqual(['VOICE_PERIOD_NOT_CONFIGURED'])
})
it.each([1, 2])('requires an explicit requested period when %s periods are configured', async (count) => {
  const root = await project([voice])
  await edit(root, 'project_config.json', (doc) => {
    const row = fixtureRow(doc.project_bible.characters)
    row.voice_profiles = Array.from({ length: count }, (_, index) => ({ ...row.voice_profile, voice_period_id: `period-${index}` }))
  })
  expect((await preview(root)).result.matches[0]?.reason_codes).toEqual(['VOICE_PERIOD_REQUIRED'])
})
it('does not reuse an untagged or archived approved sample for an explicit voice period', async () => {
  const root = await project([{ ...voice, voice_period_id: 'adult' }])
  await edit(root, 'project_config.json', (doc) => {
    const row = fixtureRow(doc.project_bible.characters)
    row.voice_profiles = [{ ...row.voice_profile, voice_period_id: 'adult' }]
  })
  expect((await preview(root)).result.matches[0]?.reason_codes).toEqual(['VOICE_APPROVAL_OR_SOURCE_UNVERIFIED'])
  for (const status of ['archived', 'archived_duplicate']) {
    await edit(root, 'audio/voice-references/manifest.json', (doc) => {
      fixtureRow(doc.samples).voice_period_id = 'adult'; fixtureRow(doc.samples).status = status
    })
    expect((await preview(root)).result.matches[0]?.reason_codes).toEqual(['VOICE_APPROVAL_OR_SOURCE_UNVERIFIED'])
  }
})
it('refuses an explicit period on a legacy voice and preserves legacy output with an empty period list', async () => {
  const root = await project([{ ...voice, voice_period_id: 'adult' }])
  expect((await preview(root)).result.matches[0]?.reason_codes).toEqual(['VOICE_PERIOD_NOT_CONFIGURED'])
  await edit(root, 'requirements.json', (doc) => { doc.requirements = [voice] })
  const prior = (await preview(root)).result
  await edit(root, 'project_config.json', (doc) => { fixtureRow(doc.project_bible.characters).voice_profiles = [] })
  expect((await preview(root)).result).toEqual(prior)
  expect(prior.matches[0]).not.toHaveProperty('voice_period_id')
})
it.each([
  'not-an-array', [null], [{ voice_period_id: 42 }], [{ voice_period_id: '' }], [{ voice_period_id: 'adult', label: '' }],
  [{ voice_period_id: 'adult' }, { voice_period_id: 'adult' }],
])('blocks unreadable or ambiguous configured periods %#', async (profiles) => {
  const root = await project([{ ...voice, voice_period_id: 'adult' }])
  await edit(root, 'project_config.json', (doc) => { fixtureRow(doc.project_bible.characters).voice_profiles = profiles })
  expect((await preview(root)).result.matches[0]?.status).toBe('blocked')
})
it.each([42, '', ' '])('refuses an unreadable requested voice period %j before provider reads', async (period) => {
  const root = await project([voice])
  await edit(root, 'requirements.json', (doc) => { doc.requirements = [{ ...voice, voice_period_id: period }] })
  const { result, calls } = await preview(root)
  expect(result.issues[0]?.code).toBe('INVALID_REQUIREMENTS')
  expect(calls).toEqual([])
})
it('preserves exact voice-period IDs and does not merge surrounding whitespace into another period', async () => {
  const root = await project([{ ...voice, voice_period_id: 'adult' }])
  await edit(root, 'project_config.json', (doc) => {
    const row = fixtureRow(doc.project_bible.characters)
    row.voice_profiles = [{ ...row.voice_profile, voice_period_id: ' adult ' }]
  })
  await edit(root, 'audio/voice-references/manifest.json', (doc) => { fixtureRow(doc.samples).voice_period_id = ' adult ' })
  expect((await preview(root)).result.matches[0]?.reason_codes).toEqual(['VOICE_PERIOD_NOT_CONFIGURED'])
  await edit(root, 'requirements.json', (doc) => { doc.requirements = [{ ...voice, voice_period_id: ' adult ' }] })
  const result = (await preview(root)).result
  expect(result.matches[0]).toMatchObject({ status: 'reuse_ready', voice_period_id: ' adult ', selected_asset_id: 13 })
  expect(result.matches[0]?.evidence).toContain('voice_period_id= adult ')
})
it('keeps a conflicting requested voice description for human review', async () => {
  const root = await project([{ ...voice, conditions: ['高亢'] }])
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('VOICE_DESCRIPTION_CONFLICT')
})
it('reports no voice only when the bible, sample list and inventories are readable', async () => {
  const root = await project([voice]); await edit(root, 'project_config.json', (doc) => { delete fixtureRow(doc.project_bible.characters).voice_profile })
  await edit(root, 'audio/voice-references/manifest.json', (doc) => { doc.samples = [] })
  expect((await preview(root, { assets: assets.slice(0, 2) })).result.status).toBe('missing')
})
it('blocks rather than assuming missing when the voice manifest cannot be read', async () => {
  const root = await project([voice]); await rm(join(root, 'audio/voice-references/manifest.json'))
  expect((await preview(root)).result.status).toBe('blocked')
})
it('blocks a source SHA mismatch before any provider request', async () => {
  const root = await project(); await writeFile(join(root, 'episode.txt'), source + '\nchanged')
  const { result, calls } = await preview(root)
  expect(result.issues[0]?.code).toBe('SOURCE_CHANGED'); expect(calls).toEqual([])
})
it('blocks an incorrect source line mapping', async () => {
  const root = await project([{ ...character, source_line: 2 }])
  expect((await preview(root)).result.issues[0]?.code).toBe('SOURCE_MAPPING_CHANGED')
})
it('invalidates the preview if input files change during provider reads', async () => {
  const root = await project([character]); let first = true
  const { result } = await preview(root, { before: async () => { if (first) { first = false; await writeFile(join(root, 'episode.txt'), 'changed') } } })
  expect(result.status).toBe('blocked'); expect(result.issues[0]?.code).toBe('SOURCE_CHANGED')
})
it('blocks source directory retargeting even when both files have the same bytes', async () => {
  const root = await project([character])
  const original = join(root, 'source-original'), replacement = join(root, 'source-replacement')
  const current = join(root, 'source-current')
  await mkdir(original); await mkdir(replacement)
  await writeFile(join(original, 'episode.txt'), source)
  await writeFile(join(replacement, 'episode.txt'), source)
  await symlink(original, current, 'junction')
  await edit(root, 'requirements.json', (doc) => { doc.source_path = 'source-current/episode.txt' })
  let first = true
  const mock = provider({ before: async () => {
    if (!first) return
    first = false
    await rename(current, join(root, 'source-previous'))
    await symlink(replacement, current, 'junction')
  } })
  const result = await matchPreview(mock.client, root, 'requirements.json', limits)
  expect(result.status).toBe('blocked')
  expect(result.issues[0]?.code).toBe('SOURCE_CHANGED')
  expect(mock.calls.every(call => call.method === 'GET')).toBe(true)
  expect(result).toMatchObject({ local_writes: 0, remote_writes: 0, paid_requests: 0 })
})
it('blocks a project binding mismatch', async () => {
  const root = await project(); await edit(root, 'project_config.json', (doc) => { doc.jubian_script_id = 999 })
  expect((await preview(root)).result.issues[0]?.code).toBe('PROJECT_MISMATCH')
})
it('blocks duplicate character identities', async () => {
  const root = await project(); await edit(root, 'project_config.json', (doc) => { doc.project_bible.characters.push(fixtureRow(doc.project_bible.characters)) })
  expect((await preview(root)).result.issues[0]?.code).toBe('CHARACTER_IDENTITIES_AMBIGUOUS')
})
it('blocks unreadable JSON without exposing its contents', async () => {
  const root = await project(); await writeFile(join(root, 'project_config.json'), 'secret-token unreadable')
  const result = (await preview(root)).result
  expect(result.status).toBe('blocked'); expect(JSON.stringify(result)).not.toContain('secret-token')
})
it('reads all inventory pages including short pages until the declared total is reached', async () => {
  expect((await preview(await project(), {}, { ...limits, pageSize: 1 })).result.counts.reuse_ready).toBe(3)
})
it('blocks an empty page before the declared total', async () => {
  const { result } = await preview(await project(), { page: (kind, _n, data) => kind === 'asset' ? { ...data, total: 10, rows: [] } : data })
  expect(result.issues[0]?.code).toBe('PAGINATION_INCOMPLETE')
})
it('blocks repeated IDs across pages', async () => {
  const { result } = await preview(await project(), { page: (kind, _n, data) => kind === 'asset' ? { ...data, rows: [assets[0]] } : data }, { ...limits, pageSize: 1 })
  expect(result.issues[0]?.code).toBe('PAGINATION_INCOMPLETE')
})
it('blocks a page whose total is absent even if the response reader supplies a fallback', async () => {
  const { result } = await preview(await project(), { page: (_kind, _page, data) => ({ rows: data.rows }) })
  expect(result.issues[0]?.code).toBe('PAGINATION_INCOMPLETE')
})
it('does not reuse another character voice just because the supplied ID points at an approved sample', async () => {
  const root = await project([{ ...voice, name: '其他人' }])
  expect((await preview(root)).result.matches[0]?.reason_codes).toContain('IDENTITY_NAME_CONFLICT')
})
it('accepts provider numeric hosting IDs through the existing identity reader', async () => {
  const root = await project([character])
  const materials = [{ id: 111, scriptId: 2708, assetId: 11, isUsed: 1, hsAssetStatus: 'Active',
    hsAssetId: 11, assetUrl: assets[0]!.url }]
  expect((await preview(root, { materials })).result.status).toBe('reuse_ready')
})
it('blocks a changing inventory total', async () => {
  const { result } = await preview(await project(), { page: (kind, page, data) => kind === 'asset' && page > 1 ? { ...data, total: 4 } : data }, { ...limits, pageSize: 1 })
  expect(result.issues[0]?.code).toBe('INVENTORY_CHANGED')
})
it('blocks exhaustion of the configured page limit', async () => {
  const { result } = await preview(await project(), {}, { ...limits, pageSize: 1, pageLimit: 1 })
  expect(result.issues[0]?.code).toBe('PAGINATION_INCOMPLETE')
})
it('blocks a failed GET instead of reporting missing', async () => {
  const { result } = await preview(await project(), { before: async () => { throw new Error('offline transport failure') } })
  expect(result.status).toBe('blocked'); expect(result.counts.missing).toBe(0)
})
it('blocks another project in an otherwise valid inventory', async () => {
  const { result } = await preview(await project(), { assets: assets.map(row => ({ ...row, scriptId: 999 })) })
  expect(result.issues[0]?.code).toBe('PROJECT_MISMATCH')
})
it('does not silently treat legacy manifest spelling as a complete empty inventory', async () => {
  const root = await project(); await edit(root, 'assets_manifest.json', (doc) => { doc.assets = doc.items; expect(Reflect.deleteProperty(doc, 'items')).toBe(true) })
  expect((await preview(root)).result.issues[0]?.code).toBe('MANIFEST_UNREADABLE')
})
it('blocks invalid and duplicated requirements before remote reads', async () => {
  const root = await project([character, character])
  const { result, calls } = await preview(root)
  expect(result.status).toBe('blocked'); expect(calls).toEqual([])
})
it('blocks oversized requirements before remote reads', async () => {
  const { result, calls } = await preview(await project(), {}, { ...limits, requirementsLimit: 1 })
  expect(result.issues[0]?.code).toBe('INVALID_REQUIREMENTS'); expect(calls).toEqual([])
})
it('blocks a source outside the project instead of reading arbitrary files', async () => {
  const root = await project(); await edit(root, 'requirements.json', (doc) => { doc.source_path = '../outside.txt'; doc.source_sha256 = digest('outside') })
  expect((await preview(root)).result.status).toBe('blocked')
})
