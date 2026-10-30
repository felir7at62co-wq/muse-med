/** Candidate metadata must retain the exact native installer and recorded build identity. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { candidateUpdateSpec } from '../scripts/muse-candidate-update-acceptance.ts'

function fixture(target: 'mac-arm64' | 'win-x64' = 'mac-arm64') {
  const options = { target, version: '1.2.3', fromVersion: '1.2.2', sourceCommit: 'a'.repeat(40) }
  const base = `muse-med-1.2.3-${target}`
  const primary = `${base}.${target === 'mac-arm64' ? 'zip' : 'exe'}`
  const channel = target === 'mac-arm64' ? 'latest-mac.yml' : 'latest.yml'
  const artifacts: Record<string, { size: number; sha256: string; sha512: string }> = {}
  for (const filename of [primary, `${primary}.blockmap`, channel, ...(target === 'mac-arm64' ? [`${base}.dmg`] : [])]) {
    artifacts[filename] = { size: Buffer.byteLength(filename), sha256: createHash('sha256').update(filename).digest('hex'),
      sha512: createHash('sha512').update(filename).digest('base64') }
  }
  const first = artifacts[primary]!
  const record = { schemaVersion: 1, ...options, unsigned: true, artifacts }
  const metadata = { version: options.version, path: primary, sha512: first.sha512,
    files: [{ url: primary, size: first.size, sha512: first.sha512 }] }
  return { options, record, metadata, primary }
}

describe('real candidate update inputs', () => {
  it.each(['mac-arm64', 'win-x64'] as const)('selects the genuine %s installer and preserves source metadata', (target) => {
    const f = fixture(target)
    const before = structuredClone(f.metadata)
    const result = candidateUpdateSpec(f.record, f.metadata, f.options)
    expect(result.payload.filename).toBe(`muse-med-1.2.3-${target}.${target === 'mac-arm64' ? 'dmg' : 'exe'}`)
    expect(result.artifacts).toHaveLength(target === 'mac-arm64' ? 4 : 3)
    expect(result.metadata.files[0]!.url).toBe(f.primary)
    expect(result.metadata.files.at(-1)!.sha512).toBe(result.payload.sha512)
    expect(f.metadata).toEqual(before)
  })

  it('rejects an older version, invalid source identity and another target build', () => {
    const f = fixture()
    expect(() => candidateUpdateSpec(f.record, f.metadata, { ...f.options, fromVersion: '1.2.4' })).toThrow('increasing versions')
    expect(() => candidateUpdateSpec(f.record, f.metadata, { ...f.options, fromVersion: '1.2.3' })).toThrow('increasing versions')
    expect(() => candidateUpdateSpec(f.record, f.metadata, { ...f.options, sourceCommit: 'main' })).toThrow('exact source')
    for (const change of [{ sourceCommit: 'b'.repeat(40) }, { target: 'win-x64' }, { version: '1.2.4' }, { unsigned: false }]) {
      expect(() => candidateUpdateSpec({ ...f.record, ...change }, f.metadata, f.options)).toThrow('another build')
    }
  })

  it('rejects a channel that points outside the recorded primary payload', () => {
    const f = fixture()
    for (const change of [{ version: '1.2.2' }, { path: '../other.zip' }, { files: [] }, { files: [...f.metadata.files, ...f.metadata.files] }]) {
      expect(() => candidateUpdateSpec(f.record, { ...f.metadata, ...change }, f.options)).toThrow('channel differs')
    }
    for (const change of [{ url: 'https://other.example/other.zip' }, { size: 1 }, { sha512: 'x'.repeat(86) + '==' }]) {
      expect(() => candidateUpdateSpec(f.record, { ...f.metadata, files: [{ ...f.metadata.files[0], ...change }] }, f.options))
        .toThrow('checksum differs')
    }
  })

  it('requires complete recorded size and hashes for every shipped candidate input', () => {
    const f = fixture()
    for (const change of [{ size: 0 }, { size: 1.5 }, { sha256: 'invalid' }, { sha512: 'invalid' }]) {
      const record = structuredClone(f.record)
      record.artifacts[f.primary] = { ...record.artifacts[f.primary]!, ...change }
      expect(() => candidateUpdateSpec(record, f.metadata, f.options)).toThrow('invalid recorded artifact')
    }
    const missing = structuredClone(f.record)
    delete missing.artifacts['muse-med-1.2.3-mac-arm64.dmg']
    expect(() => candidateUpdateSpec(missing, f.metadata, f.options)).toThrow('expected a JSON object')
  })
})
