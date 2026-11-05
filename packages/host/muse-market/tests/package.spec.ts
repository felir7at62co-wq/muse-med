import { describe, it, expect } from 'vitest'
import { zipSync, unzipSync } from 'fflate'
import { createMarketPackage, readMarketPackage, marketManifest, marketPath } from '../src/package.ts'
import type { MarketManifest } from '../src/types.ts'
import { underreportedStoredZip } from './fixtures/stored-zip.ts'

const limits = { archiveBytes: 1024 * 1024, expandedBytes: 2 * 1024 * 1024, fileCount: 32 }
const manifest: MarketManifest = { formatVersion: 1, kind: 'skill', name: 'test-skill', title: 'Test', description: 'Test skill',
  version: '1.0.0', license: 'MIT', category: 'script', examples: ['Review this script'], requirements: [],
  skills: [{ name: 'test-skill', path: 'skills/test-skill/SKILL.md' }] }
const files = { 'skills/test-skill/SKILL.md': Buffer.from('---\nname: test-skill\ndescription: Review scripts\n---\nReview the supplied script.\n'),
  'skills/test-skill/references/example.md': Buffer.from('Reference example') }

describe('market publication archives', () => {
  it('round-trips complete resources and preserves invocation controls', () => {
    const archive = createMarketPackage(manifest, files, limits, [])
    const parsed = readMarketPackage(archive, limits, [])
    expect(parsed.manifest).toEqual(manifest)
    expect(Buffer.from(parsed.files['skills/test-skill/references/example.md'] ?? []).toString()).toBe('Reference example')
  })

  it.each(['../escape', '/absolute', 'C:/escape', 'a\\b', '.env', 'keys/test.pem', 'CON.txt', 'a/file.'])('refuses unsafe path %s', (path) => {
    expect(marketPath(path)).toBe(false)
    expect(() => createMarketPackage(manifest, { ...files, [path]: Buffer.from('bad') }, limits, [])).toThrow()
  })

  it('refuses undeclared or modified resources and missing instruction files', () => {
    const entries = unzipSync(createMarketPackage(manifest, files, limits, []))
    entries['skills/test-skill/references/example.md'] = Buffer.from('Changed')
    expect(() => readMarketPackage(zipSync(entries), limits, [])).toThrow('file-mismatch')
    expect(() => createMarketPackage(manifest, {}, limits, [])).toThrow('missing-skill')
  })

  it('refuses Skill trees that are absent from the manifest', () => {
    expect(() => createMarketPackage(manifest, { ...files,
      'skills/hidden/SKILL.md': Buffer.from('---\nname: hidden\ndescription: Hidden\n---\nHidden instructions\n'),
    }, limits, [])).toThrow('undeclared-skill')
  })

  it('bounds expanded bytes and entry counts before extracting content', () => {
    const archive = createMarketPackage(manifest, files, limits, [])
    expect(() => readMarketPackage(archive, { ...limits, fileCount: 1 }, [])).toThrow('expanded-limit')
    expect(() => readMarketPackage(archive, { ...limits, expandedBytes: 20 }, [])).toThrow('expanded-limit')
    expect(() => readMarketPackage(archive, { ...limits, archiveBytes: 20 }, [])).toThrow('archive-too-large')
  })

  it('rejects case-colliding files on every platform', () => {
    expect(() => createMarketPackage(manifest, { ...files, 'skills/test-skill/skill.md': Buffer.from('duplicate') }, limits, [])).toThrow('invalid-path')
  })

  it('admits only configured plugins and refuses executable expression objects', () => {
    const bot = { ...manifest, kind: 'bot' as const, plugins: [{ name: '@deepseek-ai/dsh-persona', config: { prefix: 'Review scripts' } }] }
    expect(readMarketPackage(createMarketPackage(bot, files, limits, ['@deepseek-ai/dsh-persona']), limits, ['@deepseek-ai/dsh-persona']).manifest.kind).toBe('bot')
    expect(() => createMarketPackage(bot, files, limits, [])).toThrow('invalid-manifest')
    expect(() => createMarketPackage({ ...bot, plugins: [{ name: '@deepseek-ai/dsh-persona', config: { prefix: { __jsExpr: 'process.env.SECRET' } } }] }, files, limits, ['@deepseek-ai/dsh-persona'])).toThrow('invalid-manifest')
  })

  it.each([
    ['@deepseek-ai/dsh-skill-filesystem', { customSkillDirs: ['../external-skills'] }],
    ['@deepseek-ai/dsh-muse-market/bot-skills', { releaseId: 'a'.repeat(64) }],
  ])('reserves Host-owned plugin %s even when deployment policy lists it', (name, config) => {
    const bot = { ...manifest, kind: 'bot' as const, plugins: [{ name, config }] }
    expect(() => createMarketPackage(bot, files, limits, [name])).toThrow('invalid-manifest')
  })

  it.each([undefined, null, false, {}, { scopedCatalogOwner: false },
    { scopedCatalogOwner: 'true' }, { scopedCatalogOwner: 1 }])(
    'refuses a Bot-local skill loader with incompatible config %j', (config) => {
      const bot = { ...manifest, kind: 'bot', plugins: [{ name: '@deepseek-ai/dsh-tool-skill', config }] }
      expect(() => marketManifest(bot, ['@deepseek-ai/dsh-tool-skill'])).toThrow('invalid-manifest')
    },
  )

  it('round-trips a Bot-local skill loader without changing its explicit catalog limits', () => {
    const bot: MarketManifest = { ...manifest, kind: 'bot', plugins: [{ name: '@deepseek-ai/dsh-tool-skill',
      config: { scopedCatalogOwner: true, catalogSourceLimits: { 'muse-market': 17 } } }] }
    const allowed = ['@deepseek-ai/dsh-tool-skill']
    const archive = createMarketPackage(bot, files, limits, allowed)
    expect(readMarketPackage(archive, limits, allowed).manifest.plugins).toEqual(bot.plugins)
  })

  it('rejects an incompatible skill loader nested inside a Bot plugin group', () => {
    const bot = { ...manifest, kind: 'bot', plugins: [{ name: 'cordis:group', group: true,
      config: [{ name: '@deepseek-ai/dsh-tool-skill', config: {} }] }] }
    expect(() => marketManifest(bot, ['@deepseek-ai/dsh-tool-skill'])).toThrow('invalid-manifest')
  })

  it.each([false, true])('validates Bot-local loader ownership even when disabled=%s', (disabled) => {
    const row = { name: '@deepseek-ai/dsh-tool-skill', disabled }
    expect(() => marketManifest({ ...manifest, kind: 'bot', plugins: [row] }, [row.name])).toThrow('invalid-manifest')
    const bot = { ...manifest, kind: 'bot', plugins: [{ ...row, config: { scopedCatalogOwner: true } }] }
    expect(marketManifest(bot, [row.name]).plugins).toEqual(bot.plugins)
  })

  it('normalizes an omitted Bot plugin list at the untrusted parser boundary', () => {
    const { plugins: _plugins, ...withoutPlugins } = { ...manifest, kind: 'bot' as const, plugins: [] }
    expect(marketManifest(withoutPlugins, []).plugins).toEqual([])
  })

  it('ignores portable directory entries and rejects unsafe and reserved entries', () => {
    const entries = unzipSync(createMarketPackage(manifest, files, limits, []))
    expect(readMarketPackage(zipSync({ 'skills/': new Uint8Array(), ...entries }), limits, []).manifest).toEqual(manifest)
    for (const path of ['../', 'PUBLICATION.ZIP']) {
      expect(() => readMarketPackage(zipSync({ [path]: new Uint8Array(), ...entries }), limits, [])).toThrow('invalid-path')
    }
    expect(() => readMarketPackage(new Uint8Array(24).fill(65), limits, [])).toThrow('invalid-archive')
    expect(() => readMarketPackage(new Uint8Array(), limits, [])).toThrow('archive-too-large')
  })

  it('rejects missing, oversized, malformed, or undeclared archive metadata', () => {
    expect(() => readMarketPackage(zipSync(files), limits, [])).toThrow('invalid-manifest')
    for (const invalid of [new Uint8Array(128 * 1024 + 1), Buffer.from('{'), Buffer.from('null'), Buffer.from('{}')]) {
      expect(() => readMarketPackage(zipSync({ ...files, 'muse-package.json': invalid }), limits, [])).toThrow('invalid-manifest')
    }
    const entries = unzipSync(createMarketPackage(manifest, files, limits, []))
    const data = JSON.parse(Buffer.from(entries['muse-package.json']!).toString('utf8'))
    for (const invalid of [[], [null, null], [{ path: 1 }, {}], [data.files[0], data.files[0]]]) {
      const archive = zipSync({ ...entries, 'muse-package.json': Buffer.from(JSON.stringify({ ...data, files: invalid })) })
      expect(() => readMarketPackage(archive, limits, [])).toThrow('file-mismatch')
    }
  })

  it('counts the actual payload when a stored ZIP misstates the expanded size', () => {
    const entries = unzipSync(createMarketPackage(manifest, files, limits, []))
    const path = 'skills/test-skill/references/example.md'
    const { [path]: first, ...remaining } = entries
    const archive = underreportedStoredZip({ [path]: first!, ...remaining })
    const declaredBytes = Object.values(remaining).reduce((sum, file) => sum + file.length, 0)
    expect(readMarketPackage(archive, limits, []).manifest).toEqual(manifest)
    expect(() => readMarketPackage(archive, { ...limits, expandedBytes: declaredBytes }, [])).toThrow('expanded-limit')
  })
})
