import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../third_party/plugins')

it('exports the maintained catalog loader only in the product build overlay', async () => {
  const builder = await readFile(join(root, 'build.mjs'), 'utf8')
  expect(builder).toContain("manifest.exports['./catalog']")
  expect(builder).toContain("import('dshmarket/catalog')")
  const upstream = JSON.parse(await readFile(join(root, 'dshmarket/package.json'), 'utf8')) as { exports: Record<string, unknown> }
  expect(upstream.exports['./catalog']).toBeUndefined()
})

it('retains pinned community source and licenses without installed runtime data', async () => {
  const pins = JSON.parse(await readFile(join(root, 'sources.json'), 'utf8')) as Record<string, {
    repository: string
    version: string
    commit: string
    license: string
  }>
  expect(Object.keys(pins).sort()).toEqual([
    'dsh-codex-subscription', 'dsh-ffmpeg', 'dsh-lark-bridge', 'dsh-ponytail', 'dshmarket',
  ])
  for (const [directory, pin] of Object.entries(pins)) {
    const sourceDir = join(root, directory)
    const manifest = JSON.parse(await readFile(join(sourceDir, 'package.json'), 'utf8')) as {
      version: string
      license: string
    }
    expect(manifest.version, directory).toBe(pin.version)
    expect(manifest.license, directory).toBe(pin.license)
    expect(pin.commit, directory).toMatch(/^[a-f0-9]{40}$/)
    expect(pin.repository, directory).toMatch(/^https:\/\/github\.com\//)
    expect((await stat(join(sourceDir, 'src'))).isDirectory(), directory).toBe(true)
    expect((await readFile(join(sourceDir, 'LICENSE'), 'utf8')).length, directory).toBeGreaterThan(0)
    expect(await readdir(sourceDir), directory).not.toContain('node_modules')
    expect(await readdir(sourceDir), directory).not.toContain('lib')
    expect(await readdir(sourceDir), directory).not.toContain('.git')
  }
  expect((await readFile(join(root, 'dsh-codex-subscription', 'THIRD_PARTY_NOTICES.md'), 'utf8')))
    .toContain('ag-psd')
})
