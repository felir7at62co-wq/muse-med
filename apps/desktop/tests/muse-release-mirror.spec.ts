import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { createMuseMirrorPlan, recordMuseUnsignedBuild } from '../scripts/muse-release-mirror.mjs'
import { desktopUpdateIdentity } from '../src/update-sources.ts'
import type { UpdateInfo } from 'electron-updater'

const roots: string[] = []
const sourceCommit = 'a'.repeat(40)
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(version = '1.0.2') {
  const root = await mkdtemp(join(tmpdir(), 'muse-release-mirror-'))
  roots.push(root)
  const artifactDirectories: Record<string, string> = {}
  const channel = version.includes('-beta.') ? 'beta' : 'latest'
  for (const target of ['mac-arm64', 'win-x64']) {
    const directory = join(root, target)
    artifactDirectories[target] = directory
    await mkdir(directory)
    const extension = target.startsWith('mac-') ? 'zip' : 'exe'
    const filename = `muse-med-${version}-${target}.${extension}`
    const contents = `verified ${target} payload`
    await writeFile(join(directory, filename), contents)
    await writeFile(join(directory, `${filename}.blockmap`), `${target} blockmap`)
    if (extension === 'zip') await writeFile(join(directory, `muse-med-${version}-${target}.dmg`), `${target} installer`)
    const metadataName = `${channel}${extension === 'zip' ? '-mac' : ''}.yml`
    await writeFile(join(directory, metadataName), JSON.stringify({ version, path: filename,
      sha512: createHash('sha512').update(contents).digest('base64'),
      files: [{ url: filename, size: Buffer.byteLength(contents), sha512: createHash('sha512').update(contents).digest('base64') }] }))
    await recordMuseUnsignedBuild({ target, version, sourceCommit, artifactsRoot: directory })
  }
  return { version, sourceCommit, artifactDirectories, legacyRcDiscovery: true }
}

describe('Muse release mirror validation', () => {
  it('retains genuine versions, exact source commits and identical Mac payload identities on both mirrors', async () => {
    const f = await fixture()
    const plan = await createMuseMirrorPlan(f)
    expect(plan.artifacts).toHaveLength(5)
    expect(plan.metadata).toHaveLength(4)
    expect(plan.githubMetadata.map(file => file.filename)).toEqual(['latest-mac.yml', 'rc-mac.yml', 'latest.yml', 'rc.yml'])
    expect(plan.version).toBe(f.version)
    expect(plan.sourceCommit).toBe(sourceCommit)
    const github = load(plan.githubMetadata.find(file => file.filename === 'latest-mac.yml')!.contents) as UpdateInfo
    expect(github.files).toHaveLength(1)
    for (const target of ['mac-arm64']) {
      const mirrored = load(plan.metadata.find(file => file.key === `releases/feeds/${target}/latest-mac.yml`)!.contents) as UpdateInfo
      expect(desktopUpdateIdentity(mirrored)).toBe(desktopUpdateIdentity(github))
      expect(mirrored.files.every(file => file.url.startsWith('https://muse.tos-cn-beijing.volces.com/releases/1.0.2/'))).toBe(true)
      expect(mirrored.version).toBe('1.0.2')
    }
    expect(plan.artifacts.every(file => file.key.startsWith(`releases/${f.version}/`))).toBe(true)
  })

  it('publishes prerelease aliases with the actual beta version', async () => {
    const f = await fixture('1.0.3-beta.1')
    const plan = await createMuseMirrorPlan(f)
    expect(plan.metadata).toHaveLength(6)
    expect(plan.metadata.every(file => (load(file.contents) as UpdateInfo).version === f.version)).toBe(true)
    expect(plan.githubMetadata.map(file => file.filename)).toEqual(['beta-mac.yml', 'rc-mac.yml', 'latest-mac.yml', 'beta.yml', 'rc.yml', 'latest.yml'])
  })

  it('refuses to combine builds from different source commits', async () => {
    const f = await fixture()
    const path = join(f.artifactDirectories['mac-arm64']!, 'unsigned-build.json')
    const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...record, sourceCommit: 'b'.repeat(40) }))
    await expect(createMuseMirrorPlan(f)).rejects.toThrow(/another build/u)
  })

  it('rejects artifact changes after the completed build record', async () => {
    const f = await fixture()
    await writeFile(join(f.artifactDirectories['win-x64']!, 'muse-med-1.0.2-win-x64.exe'), 'replacement installer')
    await expect(createMuseMirrorPlan(f)).rejects.toThrow(/changed after packaging/u)
  })

  it('requires every platform and its verified hashes', async () => {
    const f = await fixture()
    delete f.artifactDirectories['win-x64']
    await expect(createMuseMirrorPlan(f)).rejects.toThrow(/missing win-x64/u)
  })

  it('rejects a metadata file that selects an unrelated installer', async () => {
    const f = await fixture()
    const root = f.artifactDirectories['win-x64']!
    const path = join(root, 'latest.yml')
    const metadata = JSON.parse(await readFile(path, 'utf8')) as UpdateInfo
    metadata.files[0]!.url = 'https://another.example.com/installer.exe'
    await writeFile(path, JSON.stringify(metadata))
    await recordMuseUnsignedBuild({ target: 'win-x64', version: f.version, sourceCommit, artifactsRoot: root })
    await expect(createMuseMirrorPlan(f)).rejects.toThrow(/checksum differs/u)
  })

  it('rejects invalid commits and unsupported targets before recording files', async () => {
    const f = await fixture()
    await expect(createMuseMirrorPlan({ ...f, sourceCommit: 'latest' })).rejects.toThrow(/exact source commit/u)
    await expect(recordMuseUnsignedBuild({ target: 'linux-x64', version: f.version, sourceCommit,
      artifactsRoot: f.artifactDirectories['win-x64']! })).rejects.toThrow(/unsupported target/u)
  })
})
