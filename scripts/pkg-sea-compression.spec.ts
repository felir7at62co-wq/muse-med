/** Execute source, main and worker SEA readers against bounded compressed assets. */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { brotliCompressSync, gzipSync, zstdCompressSync } from 'node:zlib'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const pkgRoot = dirname(require.resolve('@yao-pkg/pkg/package.json'))
const bundle = readFileSync(join(pkgRoot, 'prelude/sea-bootstrap.bundle.js'), 'utf8')
const source = readFileSync(join(pkgRoot, 'prelude/sea-vfs-setup.js'), 'utf8')

function initializer(source: string, name: string): string {
  const parsed = ts.createSourceFile('prelude.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let expression: string | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      expression = node.initializer?.getText(parsed)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  if (expression === undefined) throw new Error(`pkg prelude is missing ${name}`)
  return expression
}

function commonJs(callbacks: Record<string, (exports: object, module: { exports: unknown }) => void>) {
  return () => {
    const exports = {}
    const module: { exports: unknown } = { exports }
    Object.values(callbacks)[0]!(exports, module)
    return module.exports
  }
}

const workerSource: unknown = runInNewContext(`(${initializer(bundle, 'require_worker_bootstrap_string')})()`, { __commonJS: commonJs })
if (typeof workerSource !== 'string') throw new Error('pkg worker bootstrap must be JavaScript text')

interface Provider {
  readFileSync(path: string): Buffer
  readonly fileCacheSize: number
}

const codecs = [
  { name: 'Brotli', id: 2, compress: (contents: Buffer) => brotliCompressSync(contents) },
  { name: 'GZip', id: 1, compress: (contents: Buffer) => gzipSync(contents) },
  { name: 'Zstd', id: 3, compress: (contents: Buffer) => zstdCompressSync(contents) },
] as const

function provider(face: string, source: string, archive: Buffer, compression: number, declaredSize: number): Provider {
  const manifest = {
    compression,
    entrypoint: '/fixture', directories: {}, symlinks: {},
    offsets: { '/fixture': [0, archive.length] },
    stats: { '/fixture': { size: declaredSize, isFile: true, isDirectory: false } },
  }
  class MemoryProvider {
    mkdirSync(): void {}
  }
  class VirtualFileSystem {
    mount(): void {}
  }
  const expression = face === 'source'
    ? `(() => { const module = { exports: {} }; ${source}\nreturn module.exports })()`
    : `(${initializer(source, 'require_sea_vfs_setup')})()`
  const shared = (): unknown => require(join(pkgRoot, 'prelude/bootstrap-shared.js'))
  const loaded = runInNewContext(expression, {
    __commonJS: commonJs,
    require_bootstrap_shared: shared,
    require: (name: string): unknown => {
      if (name === './bootstrap-shared') return shared()
      if (name === 'node:sea') return {
        getAsset: () => JSON.stringify(manifest),
        getRawAsset: () => Uint8Array.from(archive).buffer,
      }
      if (name === 'node:vfs') return { MemoryProvider, VirtualFileSystem }
      throw new Error(`unexpected pkg fixture dependency: ${name}`)
    },
    Buffer,
    process: { env: {}, platform: 'linux' },
  }) as { provider: Provider }
  return loaded.provider
}

describe.each([['source', source], ['main', bundle], ['worker', workerSource]] as const)('pkg compressed assets in %s', (face, source) => {
  describe.each(codecs)('$name', (codec) => {
    const reader = (contents: Buffer, declaredSize = contents.length): Provider =>
      provider(face, source, codec.compress(contents), codec.id, declaredSize)

    function rejectsWithoutCaching(subject: Provider, message?: string): void {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (message === undefined) expect(() => subject.readFileSync('/fixture')).toThrow()
        else expect(() => subject.readFileSync('/fixture')).toThrow(message)
        expect(subject.fileCacheSize).toBe(0)
      }
    }

    it('reads and caches an empty file', () => {
      const subject = reader(Buffer.alloc(0))
      expect(subject.readFileSync('/fixture')).toEqual(Buffer.alloc(0))
      expect(subject.readFileSync('/fixture')).toEqual(Buffer.alloc(0))
      expect(subject.fileCacheSize).toBe(1)
    })

    it('preserves exact bytes and isolates cached data from callers', () => {
      const subject = reader(Buffer.from('content'))
      const first = subject.readFileSync('/fixture')
      first.fill(0)
      expect(subject.readFileSync('/fixture')).toEqual(Buffer.from('content'))
      expect(subject.fileCacheSize).toBe(1)
    })

    it('rejects a damaged archive declared empty without caching it', () => {
      rejectsWithoutCaching(provider(face, source, Buffer.from([255, 255, 255]), codec.id, 0))
    })

    it('rejects one byte declared empty without caching it', () => {
      rejectsWithoutCaching(reader(Buffer.from('x'), 0), 'decompressed size does not match stats.size')
    })

    it('rejects two bytes declared empty without caching them', () => {
      rejectsWithoutCaching(reader(Buffer.from('xy'), 0))
    })

    it('rejects output above a positive declared size without caching it', () => {
      rejectsWithoutCaching(reader(Buffer.from('xy'), 1))
    })

    it('rejects output below a positive declared size without caching it', () => {
      rejectsWithoutCaching(reader(Buffer.from('x'), 2), 'decompressed size does not match stats.size')
    })
  })
})
