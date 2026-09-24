import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { desktopPluginCatalog, parseCatalog, repositoryUrl } from '../src/plugin-catalog.ts'
import { DESKTOP_SOURCE_PLUGINS } from '../src/core-package-set.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-catalog-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-ffmpeg'] } } }))
  for (const name of DESKTOP_SOURCE_PLUGINS) {
    const directory = join(root, 'node_modules', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0',
      type: 'module', exports: { './catalog': './catalog.js' } }))
  }
  writeFileSync(join(root, 'node_modules/dshmarket/catalog.js'),
    'export async function loadRegistry() { throw new Error("fixture catalog offline") }')
  return root
}

it('lists all bundled packages offline without fetching the catalog', async () => {
  const root = fixture()
  const result = await desktopPluginCatalog(root, root, false)
  expect(result.bundled.map(row => row.name)).toEqual([...DESKTOP_SOURCE_PLUGINS])
  expect(result.bundled.find(row => row.name === 'dsh-ffmpeg')).toMatchObject({ version: '1.0.0', mounted: true })
  expect(result.bundled.find(row => row.name === '@moyu-good/dsh-lark-bridge')).toMatchObject({ mounted: false })
  expect(result.plugins).toEqual([])
  await expect(desktopPluginCatalog(root, root, true)).rejects.toThrow('fixture catalog offline')
  expect((await desktopPluginCatalog(root, root, false)).bundled).toHaveLength(5)
})

it('returns only validated catalog leaves, preserving unsupported and bundled entries', () => {
  const result = parseCatalog({ plugins: [
    { name: 'ordinary', npm: 'safe-plugin@1.2.3', url: 'https://github.com/author/plugin',
      description: { en: '<script>external text</script>', zh: '插件' }, install: 'malicious shell text' },
    { name: 'git-only', npm: null, url: 'https://github.com/author/git-only', description: {} },
    { name: 'FFmpeg', npm: 'dsh-ffmpeg', url: 'https://github.com/author/ffmpeg', description: {} },
  ] })
  expect(result).toEqual([
    { name: 'ordinary', npm: 'safe-plugin@1.2.3', repository: 'https://github.com/author/plugin',
      description: { en: '<script>external text</script>', zh: '插件' }, bundled: false },
    { name: 'git-only', repository: 'https://github.com/author/git-only', description: {}, bundled: false },
    { name: 'FFmpeg', npm: 'dsh-ffmpeg', repository: 'https://github.com/author/ffmpeg', description: {}, bundled: true },
  ])
})

it.each([
  { plugins: null },
  { plugins: [{ name: 12 }] },
  { plugins: [{ name: 'bad\nname', url: 'https://github.com/a/b' }] },
  { plugins: [{ name: 'bad', npm: '--config.ignore-scripts=false', url: 'https://github.com/a/b' }] },
  { plugins: [{ name: 'bad', npm: 'file:../local', url: 'https://github.com/a/b' }] },
  { plugins: [{ name: 'bad', url: 'javascript:alert(1)' }] },
  { plugins: [{ name: 'bad', url: 'https://github.com/a/b', description: { en: 1 } }] },
])('rejects malformed remote catalog data %#', (value) => {
  expect(() => parseCatalog(value)).toThrow()
})

it.each(['file:///C:/Windows', 'https://github.com@evil.test/a/b', 'https://github.com/a/b?redirect=evil',
  'https://github.com/login', 'https://github.com:444/a/b'])('rejects unsafe repository links %s', (url) => {
  expect(() => repositoryUrl(url)).toThrow()
})

it('accepts public GitHub repository subdirectory links', () => {
  expect(repositoryUrl('https://github.com/author/plugins/tree/main/one')).toBe('https://github.com/author/plugins/tree/main/one')
})
