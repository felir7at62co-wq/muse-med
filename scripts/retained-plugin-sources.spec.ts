import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { assertEmbeddedPluginSourceIntegrity, createRegularRepositorySourceReader, readRetainedPluginOrigins } from './retained-plugin-sources.ts'

it('keeps source reads inside the canonical repository and rejects non-files and escaping paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'retained-reader-'))
  try {
    mkdirSync(join(root, 'regular'))
    writeFileSync(join(root, 'regular/source.ts'), 'export {}\n')
    const read = createRegularRepositorySourceReader(root)
    expect(read('regular/source.ts')?.toString()).toBe('export {}\n')
    expect(read('missing/source.ts')).toBeUndefined()
    expect(() => read('regular')).toThrow(/regular file/u)
    for (const path of ['../outside.ts', '/absolute.ts', 'C:/outside.ts', 'regular\\source.ts', './regular/source.ts']) {
      expect(() => read(path)).toThrow(/Invalid repository source path/u)
    }
    expect(() => createRegularRepositorySourceReader(join(root, 'regular/source.ts'))).toThrow(/regular directory/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('qualifies the complete reviewed 32 immutable and 5 maintained real upstream files', () => {
  const origins = readRetainedPluginOrigins(resolve(import.meta.dirname, '..'))
  expect(origins.size).toBe(37)
  expect([...origins.values()].filter(origin => origin.kind === 'exact')).toHaveLength(32)
  expect([...origins.values()].filter(origin => origin.kind === 'maintained')).toHaveLength(5)
  const storage = origins.get('third_party/plugins/dsh-visualize/tests/storage.spec.ts')
  expect(storage?.kind).toBe('maintained')
  if (storage?.kind !== 'maintained') throw new Error('Reviewed storage source must retain its original text')
  expect(storage.originalLine(55)).toBe(49)
  expect(storage.originalLine(303)).toBe(195)
  expect(storage.originalLine(35)).toBeUndefined()
  const images = origins.get('third_party/plugins/dsh-visualize/tests/card-images.spec.ts')
  if (images?.kind !== 'maintained') throw new Error('Reviewed image source must retain its original text')
  expect(images.originalLine(59)).toBe(53)
})

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
