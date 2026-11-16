import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { AppInfo, Packager } from 'app-builder-lib'
import { expandMacro } from 'app-builder-lib/out/util/macroExpander.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveFiles } from 'electron-updater/out/providers/Provider.js'
import { createMuseMirrorPlan, recordMuseUnsignedBuild } from '../scripts/muse-release-mirror.mjs'
import { selectMacOSUpdateDiskImage } from '../src/macos-manual-updater.ts'
import { verifyMacOSUpdateBytes } from '../src/macos-update-package.ts'
import { desktopUpdateIdentity } from '../src/update-sources.ts'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import type { UpdateInfo } from 'electron-updater'

vi.mock('electron', () => ({ shell: {} }))

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
  it.each(['mac-arm64', 'win-x64'] as const)('records the actual unsigned packaging filenames for %s', async (target) => {
    const mac = target === 'mac-arm64'
    const platform = mac ? 'darwin' : 'win32'
    const arch = mac ? 'arm64' : 'x64'
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.muse', DSH_DESKTOP_UNSIGNED: '1',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: 'false',
    }, platform, arch)
    const packager = new Packager({ projectDir: tmpdir() })
    Object.defineProperties(packager, {
      config: { value: config },
      metadata: { value: config.extraMetadata },
    })
    const appInfo = new AppInfo(packager, undefined)
    const directory = await mkdtemp(join(tmpdir(), 'muse-unsigned-packaging-'))
    roots.push(directory)
    expect(config.directories.output).toMatch(/unsigned-artifacts$/u)
    const extensions = mac ? ['dmg', 'zip'] : ['exe']
    const payloads = extensions.map(ext => expandMacro(config.artifactName, arch, appInfo, { os: mac ? 'mac' : 'win', ext }))
    for (const filename of payloads) await writeFile(join(directory, filename), `verified ${filename}`)
    const primary = payloads.at(-1)!
    const bytes = await readFile(join(directory, primary))
    const sha512 = createHash('sha512').update(bytes).digest('base64')
    await writeFile(join(directory, `${primary}.blockmap`), 'verified blockmap')
    const channel = config.publish[0].channel
    const metadata = `${channel}${mac ? '-mac' : ''}.yml`
    await writeFile(join(directory, metadata), JSON.stringify({ version: appInfo.version, path: primary, sha512,
      files: [{ url: primary, size: bytes.length, sha512 }] }))
    const record = await recordMuseUnsignedBuild({ target, version: appInfo.version, sourceCommit, artifactsRoot: directory })
    const artifacts: Record<string, { size: number; sha256: string; sha512: string }> = {}
    for (const filename of [...payloads, `${primary}.blockmap`, metadata]) {
      const contents = await readFile(join(directory, filename))
      artifacts[filename] = { size: contents.length, sha256: createHash('sha256').update(contents).digest('hex'),
        sha512: createHash('sha512').update(contents).digest('base64') }
    }
    expect(record).toEqual({ schemaVersion: 1, target, version: appInfo.version, sourceCommit, unsigned: true,
      artifacts })
    const plan = await createMuseMirrorPlan({ version: appInfo.version, sourceCommit, targets: [target],
      artifactDirectories: { [target]: directory } })
    expect(plan.artifacts.map(file => file.filename)).toEqual([...payloads, `${primary}.blockmap`])
    expect(plan.artifacts.map(file => file.path)).toEqual([...payloads, `${primary}.blockmap`].map(name => join(directory, name)))
    expect(await readFile(join(directory, primary))).toEqual(bytes)
  })

  it('does not substitute a suffixed or unrelated installer for the exact Windows artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muse-unsigned-missing-'))
    roots.push(directory)
    await writeFile(join(directory, 'muse-med-1.0.2-win-x64-unsigned.exe'), 'old naming')
    await writeFile(join(directory, 'unrelated.exe'), 'unrelated installer')
    await expect(recordMuseUnsignedBuild({ target: 'win-x64', version: '1.0.2', sourceCommit, artifactsRoot: directory }))
      .rejects.toMatchObject({ code: 'ENOENT', path: join(directory, 'muse-med-1.0.2-win-x64.exe') })
    await expect(readFile(join(directory, 'unsigned-build.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('publishes only explicitly selected Windows files and leaves Mac feeds outside the plan', async () => {
    const f = await fixture()
    const plan = await createMuseMirrorPlan({ ...f, targets: ['win-x64'],
      artifactDirectories: { 'win-x64': f.artifactDirectories['win-x64']! } })
    expect(plan.artifacts.map(file => file.filename)).toEqual([
      'muse-med-1.0.2-win-x64.exe', 'muse-med-1.0.2-win-x64.exe.blockmap',
    ])
    expect(plan.metadata.map(file => file.key)).toEqual([
      'releases/feeds/win-x64/latest.yml', 'releases/feeds/win-x64/rc.yml',
    ])
    expect(plan.githubMetadata.map(file => file.filename)).toEqual(['latest.yml', 'rc.yml'])
    await expect(createMuseMirrorPlan({ ...f, artifactDirectories: { 'win-x64': f.artifactDirectories['win-x64']! } }))
      .rejects.toThrow('missing mac-arm64 artifact directory')
    for (const targets of [[], ['win-x64', 'win-x64'], ['win-arm64']]) {
      await expect(createMuseMirrorPlan({ ...f, targets })).rejects.toThrow('invalid release targets')
    }
  })

  it('retains genuine versions, exact source commits and identical Mac payload identities on both mirrors', async () => {
    const f = await fixture()
    const originalMac = load(await readFile(join(f.artifactDirectories['mac-arm64']!, 'latest-mac.yml'), 'utf8')) as UpdateInfo
    const originalWin = load(await readFile(join(f.artifactDirectories['win-x64']!, 'latest.yml'), 'utf8')) as UpdateInfo
    const originalBytes = new Map<string, Buffer>()
    for (const directory of Object.values(f.artifactDirectories)) {
      for (const filename of await readdir(directory)) {
        const path = join(directory, filename)
        originalBytes.set(path, await readFile(path))
      }
    }
    expect(() => selectMacOSUpdateDiskImage(resolveFiles(originalMac, new URL('https://github.example.com/releases/')), f.version, 'arm64'))
      .toThrow('exactly one architecture-matched Muse disk image')
    const plan = await createMuseMirrorPlan(f)
    expect(plan.artifacts).toHaveLength(5)
    expect(plan.metadata).toHaveLength(4)
    expect(plan.githubMetadata.map(file => file.filename)).toEqual(['latest-mac.yml', 'rc-mac.yml', 'latest.yml', 'rc.yml'])
    expect(plan.version).toBe(f.version)
    expect(plan.sourceCommit).toBe(sourceCommit)
    const github = load(plan.githubMetadata.find(file => file.filename === 'latest-mac.yml')!.contents) as UpdateInfo
    expect(github.files).toHaveLength(2)
    expect(github.files[0]).toEqual(originalMac.files[0])
    expect(github).toMatchObject({ path: originalMac.files[0]!.url, sha512: originalMac.files[0]!.sha512 })
    for (const name of ['latest-mac.yml', 'rc-mac.yml']) {
      const mirrored = load(plan.metadata.find(file => file.key === `releases/feeds/mac-arm64/${name}`)!.contents) as UpdateInfo
      const githubAlias = load(plan.githubMetadata.find(file => file.filename === name)!.contents) as UpdateInfo
      expect(desktopUpdateIdentity(mirrored)).toBe(desktopUpdateIdentity(github))
      expect(githubAlias).toEqual(github)
      expect(mirrored.files.every(file => file.url.startsWith('https://muse.tos-cn-beijing.volces.com/releases/1.0.2/'))).toBe(true)
      expect(mirrored.version).toBe('1.0.2')
      for (const [info, base] of [[mirrored, 'https://muse.tos-cn-beijing.volces.com/releases/feeds/mac-arm64/'],
        [githubAlias, 'https://github.example.com/releases/']] as const) {
        const selected = selectMacOSUpdateDiskImage(resolveFiles(info, new URL(base)), f.version, 'arm64')
        const artifact = plan.artifacts.find(file => file.filename === 'muse-med-1.0.2-mac-arm64.dmg')!
        expect(selected.info.sha512).toBe(artifact.sha512)
        expect(selected.info.size).toBe(artifact.size)
        if (info === mirrored) expect(selected.url.href).toBe(`https://muse.tos-cn-beijing.volces.com/${artifact.key}`)
        await expect(verifyMacOSUpdateBytes({ path: artifact.path, version: f.version, appId: 'cn.muse.med', arch: 'arm64',
          sha512: selected.info.sha512, size: selected.info.size })).resolves.toBeUndefined()
      }
    }
    for (const name of ['latest.yml', 'rc.yml']) {
      expect(load(plan.githubMetadata.find(file => file.filename === name)!.contents)).toEqual(originalWin)
      const mirrored = load(plan.metadata.find(file => file.key === `releases/feeds/win-x64/${name}`)!.contents) as UpdateInfo
      expect(mirrored.files).toHaveLength(1)
      expect(desktopUpdateIdentity(mirrored)).toBe(desktopUpdateIdentity(originalWin))
    }
    expect(plan.artifacts.every(file => file.key.startsWith(`releases/${f.version}/`))).toBe(true)
    for (const [path, bytes] of originalBytes) expect(await readFile(path)).toEqual(bytes)
  })

  it('rejects wrong-architecture, duplicate and incomplete disk images in the published consumer metadata', async () => {
    const f = await fixture()
    const plan = await createMuseMirrorPlan(f)
    const metadata = load(plan.githubMetadata.find(file => file.filename === 'latest-mac.yml')!.contents) as UpdateInfo
    const zip = metadata.files[0]!, dmg = metadata.files[1]!
    for (const files of [[zip, { ...dmg, url: 'muse-med-1.0.2-mac-x64.dmg' }], [zip, dmg, dmg],
      [zip, { ...dmg, sha512: 'invalid' }], [zip, { ...dmg, size: 0 }]]) {
      expect(() => selectMacOSUpdateDiskImage(resolveFiles({ ...metadata, files }, new URL('https://github.example.com/releases/')), f.version, 'arm64'))
        .toThrow('macOS update')
    }
    const artifact = plan.artifacts.find(file => file.filename === dmg.url)!
    await expect(verifyMacOSUpdateBytes({ path: artifact.path, version: f.version, appId: 'cn.muse.med', arch: 'arm64', size: artifact.size,
      sha512: createHash('sha512').update('different disk image').digest('base64') })).rejects.toThrow('disk image SHA-512 differs')
  })

  it('rejects a disk image changed after its packaging record', async () => {
    const f = await fixture()
    await writeFile(join(f.artifactDirectories['mac-arm64']!, 'muse-med-1.0.2-mac-arm64.dmg'), 'replacement disk image')
    await expect(createMuseMirrorPlan(f)).rejects.toThrow(/changed after packaging/u)
  })

  it('requires the original Mac channel to select its ZIP before adding a disk image', async () => {
    const f = await fixture()
    const root = f.artifactDirectories['mac-arm64']!
    const filename = 'muse-med-1.0.2-mac-arm64.dmg'
    const bytes = await readFile(join(root, filename))
    const sha512 = createHash('sha512').update(bytes).digest('base64')
    await writeFile(join(root, 'latest-mac.yml'), JSON.stringify({ version: f.version, path: filename, sha512,
      files: [{ url: filename, size: bytes.length, sha512 }] }))
    await recordMuseUnsignedBuild({ target: 'mac-arm64', version: f.version, sourceCommit, artifactsRoot: root })
    await expect(createMuseMirrorPlan(f)).rejects.toThrow(/checksum differs/u)
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

  it.each(['path', 'sha512'] as const)('rejects an original channel whose legacy %s differs from its verified payload', async (field) => {
    const f = await fixture()
    const root = f.artifactDirectories['mac-arm64']!
    const path = join(root, 'latest-mac.yml')
    const metadata = JSON.parse(await readFile(path, 'utf8')) as UpdateInfo
    await writeFile(path, JSON.stringify({ ...metadata, [field]: 'different payload' }))
    await recordMuseUnsignedBuild({ target: 'mac-arm64', version: f.version, sourceCommit, artifactsRoot: root })
    await expect(createMuseMirrorPlan(f)).rejects.toThrow(/checksum differs/u)
  })

  it('rejects invalid commits and unsupported targets before recording files', async () => {
    const f = await fixture()
    await expect(createMuseMirrorPlan({ ...f, sourceCommit: 'latest' })).rejects.toThrow(/exact source commit/u)
    await expect(recordMuseUnsignedBuild({ target: 'linux-x64', version: f.version, sourceCommit,
      artifactsRoot: f.artifactDirectories['win-x64']! })).rejects.toThrow(/unsupported target/u)
  })
})
