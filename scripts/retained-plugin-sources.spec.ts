import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assertEmbeddedPluginSourceIntegrity } from './retained-plugin-sources.ts'

it('rejects changed, missing, extra and escaping embedded sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'muse-embedded-source-'))
  try {
    const content = 'Pinned upstream fixture\n', sha256 = createHash('sha256').update(content).digest('hex')
    for (const [plugin, dir, path] of [
      ['muse-reverse-tools', 'resources/reverse-skill', 'LICENSE'],
      ['muse-fanqie-download', 'python/vendor', 'python/vendor/LICENSE'],
    ] as const) {
      const parent = join(root, 'third_party/plugins', plugin), directory = join(parent, dir)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'LICENSE'), content)
      writeFileSync(join(parent, 'SOURCE.json'), JSON.stringify({ files: [{ path, sha256 }] }))
    }
    expect(() => { assertEmbeddedPluginSourceIntegrity(root) }).not.toThrow()
    const parent = join(root, 'third_party/plugins/muse-reverse-tools'), directory = join(parent, 'resources/reverse-skill')
    writeFileSync(join(directory, 'LICENSE'), 'changed\n')
    expect(() => { assertEmbeddedPluginSourceIntegrity(root) }).toThrow(/hash mismatch/u)
    writeFileSync(join(directory, 'LICENSE'), content)
    writeFileSync(join(directory, 'extra'), content)
    expect(() => { assertEmbeddedPluginSourceIntegrity(root) }).toThrow(/hash mismatch/u)
    rmSync(join(directory, 'extra'))
    rmSync(join(directory, 'LICENSE'))
    expect(() => { assertEmbeddedPluginSourceIntegrity(root) }).toThrow(/Incomplete/u)
    writeFileSync(join(parent, 'SOURCE.json'), JSON.stringify({ files: [{ path: '../outside', sha256 }] }))
    expect(() => { assertEmbeddedPluginSourceIntegrity(root) }).toThrow(/Invalid/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
