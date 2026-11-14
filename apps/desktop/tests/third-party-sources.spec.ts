import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../third_party/plugins')
const repository = resolve(root, '../..')

it('exports the maintained catalog loader only in the product build overlay', async () => {
  const builder = await readFile(join(root, 'build.mjs'), 'utf8')
  expect(builder).toContain("manifest.exports['./catalog']")
  expect(builder).toContain("import('dshmarket/catalog')")
  const upstream = JSON.parse(await readFile(join(root, 'dshmarket/package.json'), 'utf8')) as { exports: Record<string, unknown> }
  expect(upstream.exports['./catalog']).toBeUndefined()
})

it('retains pinned community source and licenses without tracking installed runtime data', async () => {
  const trackedRuntime = execFileSync('git', [
    'ls-files', '-z', '--', ':(glob)*/node_modules', ':(glob)*/node_modules/**',
  ], { cwd: root, encoding: 'utf8' })
  expect(trackedRuntime.split('\0').filter(Boolean)).toEqual([])
  const pins = JSON.parse(await readFile(join(root, 'sources.json'), 'utf8')) as Record<string, {
    repository: string
    version: string
    commit?: string
    archiveSha256?: string
    license: string
    desktop?: boolean
  }>
  expect(Object.keys(pins).sort()).toEqual([
    'deep-view', 'ds-bot', 'dsh-bridge', 'dsh-codex-subscription', 'dsh-feishu', 'dsh-ffmpeg', 'dsh-im', 'dsh-plugin-subscriptions', 'dsh-skill-mcp-panel', 'dsh-visualize', 'dshmarket', 'muse-hongguo-search',
  ])
  expect(pins['dsh-codex-subscription']?.desktop).toBe(false)
  expect(pins['dsh-plugin-subscriptions']?.desktop).not.toBe(false)
  expect(pins['dsh-feishu']?.desktop).toBe(false)
  expect(pins['dsh-im']?.desktop).not.toBe(false)
  for (const [directory, pin] of Object.entries(pins)) {
    const sourceDir = join(root, directory)
    const manifest = JSON.parse(await readFile(join(sourceDir, 'package.json'), 'utf8')) as {
      version: string
      license: string
    }
    expect(manifest.version, directory).toBe(pin.version)
    expect(manifest.license, directory).toBe(pin.license)
    if (directory === 'muse-hongguo-search') {
      expect(pin.commit).toBeUndefined()
      expect(pin.archiveSha256).toMatch(/^[a-f0-9]{64}$/)
      const archive = await readFile(join(sourceDir, 'releases/muse-hongguo-search-0.1.0.tgz'))
      expect(createHash('sha256').update(archive).digest('hex')).toBe(pin.archiveSha256)
    } else expect(pin.commit, directory).toMatch(/^[a-f0-9]{40}$/)
    expect(pin.repository, directory).toMatch(/^https:\/\/github\.com\//)
    expect((await stat(join(sourceDir, directory === 'dsh-bridge' ? 'lib' : 'src'))).isDirectory(), directory).toBe(true)
    expect((await readFile(join(sourceDir, 'LICENSE'), 'utf8')).length, directory).toBeGreaterThan(0)
    expect(execFileSync('git', ['ls-files', '--', `third_party/plugins/${directory}/node_modules`], {
      cwd: repository,
      encoding: 'utf8',
    }), directory).toBe('')
    if (!['dsh-bridge', 'dsh-im', 'dsh-visualize'].includes(directory)) expect(await readdir(sourceDir), directory).not.toContain('lib')
    expect(await readdir(sourceDir), directory).not.toContain('.git')
  }
  expect((await readFile(join(root, 'dsh-codex-subscription', 'THIRD_PARTY_NOTICES.md'), 'utf8')))
    .toContain('ag-psd')
})
