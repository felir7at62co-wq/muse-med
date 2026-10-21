/** Packed npm readers preserve UTF-8 names and reject malformed members after the manifest. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { c as createTar, Header } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { packedIdentity, packedManifest, tarballFiles } from './tarball.ts'

const directories: string[] = []

function fixture(files: Readonly<Record<string, string>>): { root: string; archive: string } {
  const root = mkdtempSync(join(tmpdir(), 'release-tar-utf8-'))
  directories.push(root)
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(root, ...name.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }
  const archive = join(root, 'package.tgz')
  createTar({ file: archive, cwd: root, sync: true, gzip: true, portable: true }, Object.keys(files))
  return { root, archive }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('packed npm UTF-8 and complete archive validation', () => {
  it('reads a real UTF-8 PAX archive with long Chinese member names without a system tar dependency', () => {
    const manifest = { name: 'muse-reverse-tools', version: '0.1.0', peerDependencies: { '@deepseek-ai/dsh-tools': '1.0.0' } }
    const unicode = `package/resources/分析方法/${'长路径'.repeat(30)}/跨站请求伪造.md`
    const { archive } = fixture({ 'package/package.json': JSON.stringify(manifest), [unicode]: '中文方法正文\n' })
    const before = readFileSync(archive)
    expect(tarballFiles(archive)).toEqual(['package/package.json', unicode])
    expect(packedManifest(archive)).toEqual(manifest)
    expect(packedIdentity(archive)).toEqual({ name: manifest.name, version: manifest.version })
    expect(readFileSync(archive)).toEqual(before)
  })

  it('rejects corrupt or truncated members after an otherwise readable package manifest', () => {
    const { archive } = fixture({ 'package/package.json': '{"name":"fixture","version":"1.0.0"}',
      'package/after.txt': 'payload'.repeat(200) })
    const original = gunzipSync(readFileSync(archive))
    const offset = original.indexOf(Buffer.from('package/after.txt'))
    expect(offset).toBeGreaterThan(512)
    const damaged = Buffer.from(original)
    damaged[offset] = 0
    for (const bytes of [gzipSync(damaged), gzipSync(original.subarray(0, offset + 512 + 20)), Buffer.from('not an archive')]) {
      writeFileSync(archive, bytes)
      expect(() => tarballFiles(archive)).toThrow()
      expect(() => packedManifest(archive)).toThrow()
    }
  })

  it('requires one regular JSON object manifest rather than a missing, duplicate or array manifest', () => {
    const { root, archive } = fixture({ 'package/package.json': '[]', 'package/index.js': 'export {}\n' })
    expect(() => packedManifest(archive)).toThrow('has no package manifest')
    createTar({ file: archive, cwd: root, sync: true, gzip: true, portable: true }, ['package/index.js'])
    expect(() => packedManifest(archive)).toThrow('exactly one package/package.json')
    createTar({ file: archive, cwd: root, sync: true, gzip: true, portable: true },
      ['package/package.json', 'package/package.json'])
    expect(() => packedManifest(archive)).toThrow('duplicate archive member')
    writeFileSync(join(root, 'package/package.json'), 'x'.repeat(1024 * 1024 + 1))
    createTar({ file: archive, cwd: root, sync: true, gzip: true, portable: true }, ['package/package.json'])
    expect(() => packedManifest(archive)).toThrow('exceeds 1 MiB')
  })

  it('rejects traversal, drive paths, links and special members without extracting them', () => {
    const { archive } = fixture({ 'package/package.json': '{}' })
    for (const path of ['../escape', '/escape', 'C:/escape', 'package\\..\\escape']) {
      const header = Buffer.alloc(512)
      new Header({ path, type: 'File', mode: 0o644, size: 0 }).encode(header)
      writeFileSync(archive, gzipSync(Buffer.concat([header, Buffer.alloc(1024)])))
      expect(() => tarballFiles(archive)).toThrow('unsafe archive member')
    }
    for (const type of ['SymbolicLink', 'Link', 'FIFO'] as const) {
      const header = Buffer.alloc(512)
      new Header({ path: 'package/link', type, mode: 0o644, size: 0,
        ...(type === 'FIFO' ? {} : { linkpath: '../../outside' }) }).encode(header)
      writeFileSync(archive, gzipSync(Buffer.concat([header, Buffer.alloc(1024)])))
      expect(() => tarballFiles(archive)).toThrow('link or special archive member')
    }
  })
})
