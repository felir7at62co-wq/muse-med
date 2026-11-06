import { readFile } from 'node:fs/promises'
import { zipSync, unzipSync } from 'fflate'
import { expect, it } from 'vitest'
import { bindMarketPortrait, marketLegacyCatalog, marketManifest, marketRelease, marketSkill, previewMarketPackage } from '../src/format.ts'
import { marketPresetPortraitIds } from '../src/types.ts'
import { readMarketPackage } from '../src/package.ts'
import { underreportedStoredZip } from './fixtures/stored-zip.ts'

const limits = { archiveBytes: 1048576, expandedBytes: 4194304, fileCount: 64 }
const allowed = ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-skill']
const sample = async () => readFile(new URL('./fixtures/handoff/storyboard-starter-1.0.0.zip', import.meta.url))

it('previews Skill packages and rejects retired Bot previews', async () => {
  const bytes = await sample()
  expect(previewMarketPackage(bytes, limits, allowed)).toEqual(readMarketPackage(bytes, limits, allowed).manifest)
  const bot = await readFile(new URL('./fixtures/handoff/storyboard-director-1.0.0.zip', import.meta.url))
  expect(readMarketPackage(bot, limits, allowed).manifest.kind).toBe('bot')
  expect(() => previewMarketPackage(bot, limits, allowed)).toThrow('skill-only')
  expect(() => bindMarketPortrait(bot, 'video-editor', limits, allowed)).toThrow('skill-only')
})

it('binds every automatic Skill portrait and preserves the resource bytes', async () => {
  const bytes = await sample()
  const { files, manifest } = readMarketPackage(bytes, limits, allowed)
  expect(new Set(marketPresetPortraitIds).size).toBe(50)
  for (const presetPortrait of marketPresetPortraitIds) {
    const archive = bindMarketPortrait(bytes, presetPortrait, limits, allowed)
    const expected = { ...manifest, presetPortrait }
    expect(previewMarketPackage(archive, limits, allowed)).toEqual(expected)
    expect(readMarketPackage(archive, limits, allowed).files).toEqual(files)
  }
  expect(() => marketManifest({ ...manifest, portrait: 'video-editor' }, allowed)).toThrow('invalid-manifest')
  expect(() => marketManifest({ ...manifest, presetPortrait: 'unknown-portrait' }, allowed)).toThrow('invalid-manifest')
  expect(() => bindMarketPortrait(bytes, 'storyboard-director', limits, allowed)).toThrow('invalid-manifest')
})

it('keeps metadata preview separate from server resource acceptance', async () => {
  const entries = unzipSync(await sample())
  const path = Object.keys(entries).find(name => name.endsWith('/SKILL.md'))!
  entries[path] = new TextEncoder().encode('Modified resource body')
  const modified = zipSync(entries)
  expect(previewMarketPackage(modified, limits, allowed).name).toBe('storyboard-starter')
  expect(() => readMarketPackage(modified, limits, allowed)).toThrow('file-mismatch')
})

it('bounds all ZIP entries while inflating only the preview manifest', async () => {
  const bytes = await sample()
  expect(() => previewMarketPackage(bytes, { ...limits, archiveBytes: bytes.length - 1 }, allowed)).toThrow('archive-too-large')
  expect(previewMarketPackage(bytes, { ...limits, archiveBytes: bytes.length }, allowed).kind).toBe('skill')
  expect(() => previewMarketPackage(bytes, { ...limits, fileCount: 1 }, allowed)).toThrow('expanded-limit')
  expect(() => previewMarketPackage(bytes, { ...limits, expandedBytes: 1 }, allowed)).toThrow('expanded-limit')
  expect(() => previewMarketPackage(new Uint8Array(), limits, allowed)).toThrow('archive-too-large')
  expect(() => previewMarketPackage(new Uint8Array([1, 2, 3]), limits, allowed)).toThrow('invalid-archive')
})

it('refuses unsafe preview paths, missing metadata and malformed UTF-8 or JSON', async () => {
  const entries = unzipSync(await sample())
  expect(() => previewMarketPackage(zipSync({ ...entries, '../escape': new Uint8Array([1]) }), limits, allowed)).toThrow('invalid-path')
  expect(() => previewMarketPackage(zipSync({ ...entries, 'MUSE-PACKAGE.JSON': new Uint8Array([1]) }), limits, allowed)).toThrow('invalid-path')
  expect(() => previewMarketPackage(zipSync({ 'resource.txt': new Uint8Array([1]) }), limits, allowed)).toThrow('invalid-manifest')
  for (const data of [new Uint8Array([255]), new TextEncoder().encode('{'), new Uint8Array(128 * 1024 + 1)]) {
    expect(() => previewMarketPackage(zipSync({ 'muse-package.json': data }), limits, allowed)).toThrow('invalid-manifest')
  }
})

it('checks the legacy response envelope, identities and dependency lists', () => {
  const row = { id: 'muse/skills/example', kind: 'skill', name: 'Example', description: 'Review a script',
    category: 'Writing', version: '0.1.0', validation: 'Verified', sha256: 'a'.repeat(64), package: 'downloads/example.zip',
    requirements: ['Muse'], requiredSkills: ['storyboard'] }
  expect(marketLegacyCatalog({ entries: [row] }, 'EXAMPLE script', 'skill')).toEqual([
    expect.objectContaining({ href: '/market/downloads/example.zip', requiredSkills: ['storyboard'] }),
  ])
  expect(() => marketLegacyCatalog({ entries: [row] }, '', 'bot')).toThrow('skill-only')
  for (const invalid of [null, {}, { entries: Array(501).fill(row) }, { entries: [row, row] },
    { entries: [{ ...row, requiredSkills: 'storyboard' }] }, { entries: [{ ...row, requiredSkills: [1] }] }]) {
    expect(() => marketLegacyCatalog(invalid, '', '')).toThrow('invalid-response')
  }
})

it('validates required Skill and release fields at the parse boundary', async () => {
  const { manifest } = readMarketPackage(await sample(), limits, allowed)
  expect(() => marketManifest({ ...manifest, skills: null }, allowed)).toThrow('invalid-manifest')
  const release = { id: 'a'.repeat(32), publisherId: 'b'.repeat(16), publisher: 'Studio', sha256: 'a'.repeat(64), bytes: 123,
    status: 'published', reviewNote: '', revision: 1, createdAt: '2026-01-01T00:00:00.000Z', manifest }
  expect(marketRelease(release, allowed)).toEqual(release)
  expect(() => marketRelease({ ...release, createdAt: 'yesterday' }, allowed)).toThrow('invalid-release')
  const frontmatter = 'name: example\ndescription: Review\n'
  const body = (data: string, content = 'Review all scenes.') => `---\n${data}---\n${content}`
  expect(marketSkill(body(frontmatter), 'example').invocation).toEqual({ modelInvocable: true, userInvocable: true })
  for (const invalid of ['no frontmatter', body('name: [\n'), body(frontmatter + 'private: !!js 1\n'),
    body(frontmatter + 'disable-model-invocation: no\n'), body(frontmatter + 'user-invocable: off\n'), body(frontmatter, ' ')]) {
    expect(() => marketSkill(invalid, 'example')).toThrow('invalid-skill')
  }
})

it('validates nested declarative plugin configuration with an explicit depth limit', async () => {
  const { manifest } = readMarketPackage(await sample(), limits, allowed)
  const config = { styles: ['documentary', null, false, 4, { tone: 'quiet' }] }
  const plugins = [{ name: allowed[0], config }]
  const bot = { ...manifest, kind: 'bot', plugins }
  expect(marketManifest(bot, allowed).plugins).toEqual(plugins)
  let nested: object = { tone: 'quiet' }
  for (let index = 0; index < 21; index++) nested = { child: nested }
  expect(() => marketManifest({ ...bot, plugins: [{ name: allowed[0], config: nested }] }, allowed)).toThrow('invalid-manifest')
})

it('reads historical Bot portrait and scoped-loader metadata without admitting a market preview', async () => {
  const { manifest } = readMarketPackage(await sample(), limits, allowed)
  const bot = { ...manifest, kind: 'bot', skills: [] }
  const loader = '@deepseek-ai/dsh-tool-skill'
  for (const portrait of ['storyboard-director', 'screenplay-editor']) {
    expect(marketManifest({ ...bot, portrait }, allowed).portrait).toBe(portrait)
  }
  expect(marketManifest(bot, allowed).plugins).toEqual([])
  for (const row of [null, [], {}, { name: 42 }, { name: loader, disabled: 'yes' }, { name: loader, inject: ['global'] }]) {
    expect(() => marketManifest({ ...bot, plugins: [row] }, allowed)).toThrow('invalid-manifest')
  }
  expect(() => marketManifest({ ...bot, portrait: 'unknown' }, allowed)).toThrow('invalid-manifest')
  for (const config of [undefined, {}, { scopedCatalogOwner: false }]) {
    expect(() => marketManifest({ ...bot, plugins: [{ name: loader, config }] }, allowed)).toThrow('invalid-manifest')
  }
  expect(marketManifest({ ...bot, plugins: [{ name: loader, config: { scopedCatalogOwner: true } }] }, allowed).plugins)
    .toEqual([{ name: loader, config: { scopedCatalogOwner: true } }])
})

it('validates rewritten metadata and resulting ZIP limits before binding a portrait', async () => {
  const manifestPath = 'muse-package.json'
  const bytes = await sample()
  const entries = unzipSync(bytes)
  const raw = JSON.parse(Buffer.from(entries[manifestPath]!).toString('utf8')) as Record<string, unknown>
  const write = (value: unknown) => Buffer.from(JSON.stringify(value))
  const archive = zipSync({ ...entries, 'skills/': new Uint8Array() })
  expect(previewMarketPackage(archive, limits, allowed)).toEqual(previewMarketPackage(bytes, limits, allowed))
  expect(Object.keys(unzipSync(bindMarketPortrait(archive, 'video-editor', limits, allowed)))).not.toContain('skills/')
  expect(() => bindMarketPortrait(zipSync({ [manifestPath]: write(null) }), 'video-editor', limits, allowed)).toThrow('invalid-manifest')
  const updated = bindMarketPortrait(archive, 'video-editor', limits, allowed)
  const expandedBytes = Object.values(unzipSync(updated)).reduce((sum, entry) => sum + entry.length, 0)
  expect(() => bindMarketPortrait(archive, 'video-editor', { ...limits, expandedBytes: expandedBytes - 1 }, allowed)).toThrow('expanded-limit')

  const minimal = zipSync({ [manifestPath]: write(raw) }, { level: 9 })
  expect(() => bindMarketPortrait(minimal, 'horizontal-storyboard-director', { ...limits, archiveBytes: minimal.length }, allowed))
    .toThrow('archive-too-large')

  const maxManifest = { ...raw, padding: '' }
  const full = zipSync({ [manifestPath]: write({ ...maxManifest, padding: ' '.repeat(128 * 1024 - write(maxManifest).length) }) })
  expect(() => bindMarketPortrait(full, 'video-editor', limits, allowed)).toThrow('expanded-limit')
  const underreported = underreportedStoredZip({ [manifestPath]: new Uint8Array(128 * 1024 + 1) })
  expect(() => previewMarketPackage(underreported, limits, allowed)).toThrow('invalid-manifest')
})
