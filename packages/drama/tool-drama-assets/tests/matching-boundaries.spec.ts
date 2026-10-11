/** Malformed source records, incomplete provider inventories and changed files must never authorize reuse. */
import { rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { matchPreview, matchingSnapshot } from '../src/matching.ts'
import { assets, character, digest, edit, limits, matchingProject, provider, source } from './matching-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function project() { const root = await matchingProject(); roots.push(root); return root }
async function json(root: string, name: string, value: unknown) { await writeFile(join(root, name), JSON.stringify(value)) }

it.each([null, [], 'wrong'])('blocks a non-object requirement document %j', async (value) => {
  const root = await project(); await json(root, 'requirements.json', value)
  const mock = provider(), result = await matchPreview(mock.client, root, 'requirements.json', limits)
  expect(result.issues[0]?.code).toBe('INVALID_DATA'); expect(mock.calls).toEqual([])
})
it.each(['character_id', 'stable_id', 'state_or_costume'])('rejects empty supplied %s before any provider read', async (key) => {
  const root = await project(); await edit(root, 'requirements.json', (doc) => {
    doc.requirements = [{ ...character, [key]: '' }]
  })
  const mock = provider(), result = await matchPreview(mock.client, root, 'requirements.json', limits)
  expect(result.issues[0]?.code).toBe('INVALID_REQUIREMENTS'); expect(mock.calls).toEqual([])
})
it('rejects a nonpositive episode and a missing source identity', async () => {
  const root = await project()
  await edit(root, 'requirements.json', (doc) => { doc.requirements = [{ ...character, episode: 0 }] })
  expect((await matchPreview(provider().client, root, 'requirements.json', limits)).issues[0]?.code).toBe('INVALID_REQUIREMENTS')
  await edit(root, 'requirements.json', (doc) => { doc.requirements = [character]; doc.source_sha256 = 'bad' })
  expect((await matchPreview(provider().client, root, 'requirements.json', limits)).issues[0]?.code).toBe('INVALID_SOURCE')
})
it.each(['characters', 'voices'])('rejects a missing %s array', async (kind) => {
  const root = await project()
  if (kind === 'characters') await json(root, 'project_config.json', { jubian_script_id: 2708, project_bible: {} })
  else await json(root, 'audio/voice-references/manifest.json', {})
  expect((await matchPreview(provider().client, root, 'requirements.json', limits)).issues[0]?.code)
    .toBe(kind === 'characters' ? 'PROJECT_BIBLE_UNREADABLE' : 'VOICE_MANIFEST_UNREADABLE')
})
it.each(['missing', 'duplicate'])('rejects %s project character identities', async (kind) => {
  const root = await project()
  await edit(root, 'project_config.json', (doc) => {
    if (kind === 'missing') doc.project_bible.characters.push({ name: '匿名' })
    else doc.project_bible.characters.push({ character_id: 'lu', name: '另一个人' })
  })
  expect((await matchPreview(provider().client, root, 'requirements.json', limits)).issues[0]?.code).toBe('CHARACTER_IDENTITIES_AMBIGUOUS')
})
it('retains safe read failures when the entire project is unavailable', async () => {
  const root = await project(); await rm(root, { recursive: true })
  const snapshot = await matchingSnapshot(provider().client, root, 'requirements.json', limits)
  expect(snapshot.preview.status).toBe('blocked')
  expect(snapshot.input_sha256).toEqual({})
  await expect(snapshot.readJson('requirements.json')).rejects.toMatchObject({ code: 'DATA_READ_FAILED' })
  await snapshot.unchanged()
})
it.each(['overflow', 'empty-before-total'])('blocks %s inventory pages', async (kind) => {
  const root = await project(), mock = provider({ page: (_kind, _page, data) => kind === 'overflow'
    ? { ...data, total: 0 } : { ...data, total: 4, rows: [] } })
  expect((await matchPreview(mock.client, root, 'requirements.json', limits)).issues[0]?.code).toBe('PAGINATION_INCOMPLETE')
})
it('uses registered character-to-asset evidence without requiring a duplicate manifest character id', async () => {
  const root = await project()
  await edit(root, 'assets_manifest.json', (doc) => { delete doc.items[0]?.character_id; doc.items[0]!.name = '版本'; doc.items[0]!.aliases = [] })
  const result = await matchPreview(provider().client, root, 'requirements.json', limits)
  expect(result.matches[0]).toMatchObject({ status: 'reuse_ready', selected_asset_id: 11 })
})
it('blocks a parent URL changed only at final detail read', async () => {
  const root = await project()
  const mock = provider({ parent: (_id, row) => ({ ...row, url: 'https://example.invalid/replaced.png' }) })
  expect((await matchPreview(mock.client, root, 'requirements.json', limits)).matches[0]?.reason_codes).toEqual(['ASSET_SOURCE_CHANGED'])
})
it.each(['invalid-url', 'empty-url', 'no-voice-profile', 'no-samples', 'missing-voice-asset'])('keeps %s evidence out of approved reuse', async (kind) => {
  const root = await project()
  if (kind === 'invalid-url' || kind === 'empty-url') await edit(root, 'assets_manifest.json', (doc) => { doc.items[0]!.url = kind === 'invalid-url' ? 'not a url' : '' })
  else if (kind === 'no-voice-profile') await edit(root, 'project_config.json', (doc) => { delete doc.project_bible.characters[0]?.voice_profile })
  else if (kind === 'no-samples') await json(root, 'audio/voice-references/manifest.json', { samples: [] })
  const mock = provider({ ...(kind === 'missing-voice-asset' ? { assets: assets.filter(row => row.id !== 13) } : {}) })
  const result = await matchPreview(mock.client, root, 'requirements.json', limits)
  expect(result.matches[kind.includes('url') ? 0 : 2]?.status).not.toBe('reuse_ready')
})
it('does not interpret a parent transport failure as an absent asset', async () => {
  const root = await project(), mock = provider({ parent: () => { throw new Error('detail failure') } })
  expect((await matchPreview(mock.client, root, 'requirements.json', limits)).matches[0]?.reason_codes).toEqual(['DATA_READ_FAILED'])
})
it('blocks a source file changed while another requirement reads its evidence', async () => {
  const root = await project()
  await edit(root, 'audio/voice-references/manifest.json', (doc) => {
    doc.samples[0]!.source_path = 'episode.txt'; doc.samples[0]!.source_sha256 = digest(source)
  })
  const mock = provider({ before: async () => {
    await writeFile(join(root, 'episode.txt'), 'different bytes')
  } })
  expect((await matchPreview(mock.client, root, 'requirements.json', limits)).status).toBe('blocked')
})
it('rejects a project-contained source link retargeted during provider reads', async () => {
  const root = await project()
  await writeFile(join(root, 'replacement.txt'), source)
  await symlink('episode.txt', join(root, 'source-link.txt'))
  await edit(root, 'requirements.json', (doc) => { doc.source_path = 'source-link.txt' })
  const mock = provider({ before: async () => {
    await unlink(join(root, 'source-link.txt')); await symlink('replacement.txt', join(root, 'source-link.txt'))
  } })
  const result = await matchPreview(mock.client, root, 'requirements.json', limits)
  expect(result.issues[0]?.code).toBe('SOURCE_CHANGED')
})
it('keeps incomplete manifest ids as review candidates and ignores unrelated asset kinds', async () => {
  const root = await project()
  await edit(root, 'assets_manifest.json', (doc) => {
    doc.items[0]!.id = 11; delete doc.items[0]!.jubian_asset_id
    doc.items.push({ type: 'prop', name: '杯子', scene_conditions: [] })
  })
  const result = await matchPreview(provider().client, root, 'requirements.json', limits)
  expect(result.matches[0]).toMatchObject({ status: 'needs_review', candidate_asset_ids: [11] })
})
it('accepts provider name and assetUrl spellings for confirmed parent assets', async () => {
  const root = await project()
  await edit(root, 'assets_manifest.json', (doc) => {
    const row = doc.items[0]!; row.assetName = row.name; delete row.name
  })
  const rows = assets.map((row) => {
    const { assetName, url, ...rest } = row
    return { ...rest, name: assetName, assetUrl: url ?? row.assetUrl }
  })
  const result = await matchPreview(provider({ assets: rows }).client, root, 'requirements.json', limits)
  expect(result.status).toBe('reuse_ready')
})
it('refuses a project input that resolves outside its directory', async () => {
  const root = await project(), other = await project()
  await symlink(join(other, 'requirements.json'), join(root, 'foreign.json'))
  const result = await matchPreview(provider().client, root, 'foreign.json', limits)
  expect(result.issues[0]?.code).toBe('PATH_OUTSIDE_PROJECT')
})
