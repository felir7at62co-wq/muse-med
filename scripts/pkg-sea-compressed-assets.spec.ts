/** Compressed SEA readers preserve empty files and enforce declared allocation limits. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const packageRoot = dirname(createRequire(import.meta.url).resolve('@yao-pkg/pkg/package.json'))
const source = readFileSync(join(packageRoot, 'prelude', 'sea-vfs-setup.js'), 'utf8')
const bootstrap = readFileSync(join(packageRoot, 'prelude', 'sea-bootstrap.bundle.js'), 'utf8')

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('sea-bootstrap.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
}

function workerSource(): string {
  const candidates: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) && node.text.includes('function insideSnapshot(f)')) candidates.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(bootstrap))
  expect(candidates).toHaveLength(1)
  return candidates[0]!
}

interface Codec {
  compress: (input: Uint8Array) => Buffer
  decompress: (input: Uint8Array, options?: { maxOutputLength?: number }) => Buffer
}

interface ReaderState {
  _archive: Buffer
  _manifest: { offsets: Record<string, [number, number]>; stats: Record<string, { size: number }> }
  _fileCache: Map<string, Buffer>
  _decompress: Codec['decompress']
  _resolveSymlink(path: string): string
}

type ReadAsset = (this: ReaderState, path: string) => Buffer

function assetReader(source: string): ReadAsset {
  const parsed = parse(source)
  const candidates: ts.MethodDeclaration[] = []
  function visit(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && node.name.getText(parsed) === 'readFileSync'
      && node.getText(parsed).includes('this._manifest.offsets[p]')) candidates.push(node)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(candidates).toHaveLength(1)
  return runInNewContext('({' + candidates[0]!.getText(parsed) + '}).readFileSync', {
    Buffer, toManifestKey: (path: string) => path,
    _enoent: () => new Error('Missing asset'), perf: { count() {} }, perf2: { count() {} },
  }) as ReadAsset
}

const codecs: [string, Codec][] = [
  ['Brotli', { compress: brotliCompressSync, decompress: brotliDecompressSync }],
  ['GZip', { compress: gzipSync, decompress: gunzipSync }],
  ['Zstd', { compress: zstdCompressSync, decompress: zstdDecompressSync }],
]

describe.each([
  ['source', source], ['main bootstrap', bootstrap], ['worker bootstrap', workerSource()],
])('compressed assets in %s', (_name, source) => {
  const read = assetReader(source)
  function state(codec: Codec, content: Buffer, declaredSize: number, damaged = false): ReaderState {
    const archive = damaged ? Buffer.from('invalid compressed payload') : codec.compress(content)
    return {
      _archive: archive,
      _manifest: { offsets: { asset: [0, archive.length] }, stats: { asset: { size: declaredSize } } },
      _fileCache: new Map(), _decompress: codec.decompress, _resolveSymlink: path => path,
    }
  }

  it.each(codecs)('reads and caches a valid empty %s file', (_name, codec) => {
    const reader = state(codec, Buffer.alloc(0), 0)
    expect(read.call(reader, 'asset')).toEqual(Buffer.alloc(0))
    expect(read.call(reader, 'asset')).toEqual(Buffer.alloc(0))
    expect(reader._fileCache.size).toBe(1)
  })

  it.each(codecs)('reads exactly the declared nonempty %s data', (_name, codec) => {
    const reader = state(codec, Buffer.from('abc'), 3)
    expect(read.call(reader, 'asset').toString()).toBe('abc')
  })

  it.each(codecs)('rejects nonempty %s data declared empty', (_name, codec) => {
    for (const content of ['x', 'xx']) {
      const reader = state(codec, Buffer.from(content), 0)
      expect(() => read.call(reader, 'asset')).toThrow()
      expect(reader._fileCache.size).toBe(0)
    }
  })

  it.each(codecs)('rejects %s data exceeding a positive declared size', (_name, codec) => {
    const reader = state(codec, Buffer.from('abc'), 2)
    expect(() => read.call(reader, 'asset')).toThrow()
    expect(reader._fileCache.size).toBe(0)
  })

  it.each(codecs)('validates compressed bytes for an empty %s file', (_name, codec) => {
    const reader = state(codec, Buffer.alloc(0), 0, true)
    expect(() => read.call(reader, 'asset')).toThrow()
    expect(reader._fileCache.size).toBe(0)
  })
})
