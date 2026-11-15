import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectPackInputs,
  decideMemberPack,
  fileSha256,
  memberDigest,
  newPackManifest,
  packManifestFile,
  readPackManifest,
  type PackManifestMember,
} from './pack-plan.ts'

const created: string[] = []

/** Create one package fixture and return its directory. */
function packageFixture(files: Readonly<Record<string, string>>): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-pack-plan-'))
  created.push(directory)
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(directory, path)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
  return directory
}

/** The manifest member row a decision compares against. */
function recordedRow(overrides: Partial<PackManifestMember>): PackManifestMember {
  return {
    name: '@deepseek-ai/dsh-fixture',
    version: '1.0.0',
    tarball: 'deepseek-ai-dsh-fixture-1.0.0.tgz',
    bytes: 1,
    sha256: 'a'.repeat(64),
    inputSha256: 'b'.repeat(64),
    digest: 'c'.repeat(64),
    fileCount: 1,
    inputsMatchPayload: true,
    ...overrides,
  }
}

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('release pack inputs', () => {
  it('covers the declared file set, the names npm always packs, and entry points', () => {
    const directory = packageFixture({
      'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-fixture', version: '1.0.0', main: 'lib/main.js' }),
      'README.md': '# fixture\n',
      'lib/index.js': 'export {}\n',
      'lib/main.js': 'export {}\n',
      'lib/types/index.d.ts': 'export {}\n',
      'src/index.ts': 'export {}\n',
    })
    const inputs = collectPackInputs(directory, {
      name: '@deepseek-ai/dsh-fixture',
      version: '1.0.0',
      main: 'lib/main.js',
      files: ['lib/index.js', 'lib/types/**/*.d.ts'],
    })
    expect(inputs.files).toEqual([
      'README.md',
      'lib/index.js',
      'lib/main.js',
      'lib/types/index.d.ts',
      'package.json',
    ])
    expect(inputs.files).not.toContain('src/index.ts')
    expect(inputs.sha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('changes the digest when a declared file changes and when a file appears in a declared directory', () => {
    const directory = packageFixture({
      'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-fixture', version: '1.0.0' }),
      'lib/index.js': 'export {}\n',
    })
    const manifest = { name: '@deepseek-ai/dsh-fixture', version: '1.0.0', files: ['lib'] }
    const before = collectPackInputs(directory, manifest)
    writeFileSync(join(directory, 'lib', 'index.js'), 'export const changed = true\n')
    const afterEdit = collectPackInputs(directory, manifest)
    expect(afterEdit.sha256).not.toBe(before.sha256)
    writeFileSync(join(directory, 'lib', 'added.js'), 'export {}\n')
    const afterAdd = collectPackInputs(directory, manifest)
    expect(afterAdd.sha256).not.toBe(afterEdit.sha256)
    expect(afterAdd.files).toContain('lib/added.js')
  })

  it('refuses a package whose declared inputs select nothing', () => {
    const directory = packageFixture({ 'lib/index.js': 'export {}\n' })
    expect(() => collectPackInputs(directory, { files: ['dist/**/*.js'] })).toThrow(/no packable input/u)
  })
})

describe('release pack reuse decision', () => {
  it('reuses only a tarball whose bytes and inputs the record still describes', () => {
    const directory = packageFixture({ 'lib/index.js': 'export {}\n' })
    const tarball = join(directory, 'fixture.tgz')
    writeFileSync(tarball, 'tarball bytes')
    const inputs = collectPackInputs(directory, { files: ['lib'] })
    const digest = memberDigest({ inputSha256: inputs.sha256, dependencies: [], packageManager: 'pnpm@11.7.0' })
    const row = recordedRow({ digest, inputSha256: inputs.sha256, sha256: fileSha256(tarball) })
    const decision = decideMemberPack({ previous: row, filename: row.tarball, digest, tarball })
    expect(decision.reuse).toBe(true)

    expect(decideMemberPack({ previous: undefined, filename: row.tarball, digest, tarball }).reason)
      .toMatch(/no recorded inputs/u)
    expect(decideMemberPack({ previous: row, filename: 'other.tgz', digest, tarball }).reuse).toBe(false)
    expect(decideMemberPack({ previous: row, filename: row.tarball, digest: 'd'.repeat(64), tarball }).reason)
      .toMatch(/inputs, packer, or a dependency changed/u)
    expect(decideMemberPack({
      previous: recordedRow({ digest, inputsMatchPayload: false }), filename: row.tarball, digest, tarball,
    }).reason).toMatch(/did not cover the packed payload/u)
    expect(decideMemberPack({
      previous: recordedRow({ digest }), filename: row.tarball, digest, tarball: join(directory, 'gone.tgz'),
    }).reason).toMatch(/tarball is gone/u)
    expect(decideMemberPack({
      previous: recordedRow({ digest }), filename: row.tarball, digest, tarball,
    }).reason).toMatch(/no longer matches its record/u)
  })

  it('invalidates a consumer when a dependency is packed from new content', () => {
    const base = { inputSha256: '1'.repeat(64), packageManager: 'pnpm@11.7.0' }
    const unchanged = memberDigest({ ...base, dependencies: [{ name: '@deepseek-ai/dsh-dep', inputSha256: '2'.repeat(64) }] })
    expect(memberDigest({
      ...base,
      dependencies: [{ name: '@deepseek-ai/dsh-dep', inputSha256: '2'.repeat(64) }],
    })).toBe(unchanged)
    expect(memberDigest({
      ...base,
      dependencies: [{ name: '@deepseek-ai/dsh-dep', inputSha256: '3'.repeat(64) }],
    })).not.toBe(unchanged)
    expect(memberDigest({ ...base, dependencies: [], packageManager: 'pnpm@11.8.0' })).not.toBe(
      memberDigest({ ...base, dependencies: [] }),
    )
    const dependencyOrder = [
      { name: '@deepseek-ai/dsh-b', inputSha256: '4'.repeat(64) },
      { name: '@deepseek-ai/dsh-a', inputSha256: '5'.repeat(64) },
    ]
    expect(memberDigest({ ...base, dependencies: dependencyOrder })).toBe(
      memberDigest({ ...base, dependencies: [...dependencyOrder].reverse() }),
    )
  })

  it('reads back only a manifest this format wrote', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-pack-manifest-'))
    created.push(directory)
    const path = join(directory, packManifestFile('vendor'))
    expect(readPackManifest(path)).toBeUndefined()
    writeFileSync(path, 'not json')
    expect(readPackManifest(path)).toBeUndefined()
    const manifest = newPackManifest({
      family: 'vendor',
      commit: 'f'.repeat(40),
      packageManager: 'pnpm@11.7.0',
      members: [recordedRow({})],
    })
    writeFileSync(path, JSON.stringify(manifest))
    expect(readPackManifest(path)).toMatchObject({ family: 'vendor', members: [{ name: '@deepseek-ai/dsh-fixture' }] })
    expect(packManifestFile('dsh')).toBe('release-pack-dsh.json')
  })

  it('decides on tarball bytes and input content, never on timestamps', () => {
    const directory = packageFixture({ 'lib/index.js': 'export {}\n' })
    const tarball = join(directory, 'fixture.tgz')
    writeFileSync(tarball, 'tarball bytes')
    const inputs = collectPackInputs(directory, { files: ['lib'] })
    const digest = memberDigest({ inputSha256: inputs.sha256, dependencies: [], packageManager: 'pnpm@11.7.0' })
    const row = recordedRow({ digest, sha256: fileSha256(tarball), fileCount: inputs.files.length })
    const stamp = new Date(Date.now() - 60_000)
    utimesSync(tarball, stamp, stamp)
    expect(decideMemberPack({ previous: row, filename: row.tarball, digest, tarball })).toMatchObject({ reuse: true })
    // Same mtime, different bytes: the record no longer describes the tarball.
    writeFileSync(tarball, 'rewritten bytes')
    utimesSync(tarball, stamp, stamp)
    expect(decideMemberPack({ previous: row, filename: row.tarball, digest, tarball })).toMatchObject({ reuse: false })
  })
})
