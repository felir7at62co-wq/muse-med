import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { RequestOptions } from 'node:http'
import { NsisUpdater } from 'electron-updater/out/NsisUpdater.js'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import { afterEach, describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { createDesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'
import { desktopUpdateMetadataFilename } from '../scripts/desktop-auto-update-environment.mjs'
import type { DesktopPackageTargetName } from '../scripts/package-target.ts'

const temporaryDirectories: string[] = []
const TEST_ORIGIN = 'https://desktop-updates.example.com'
const TEST_BUCKET = 'test-download-bucket'
const RELEASE_ID = '0123456789abcdef0123456789abcdef'
const PRODUCTION_BUCKET = 'production-download-bucket'
const require = createRequire(import.meta.url)
const { createBlockmap } = require('app-builder-lib/out/targets/differentialUpdateInfoBuilder.js') as {
  createBlockmap: (file: string, target: object, packager: { info: { emitArtifactBuildCompleted(event: object): Promise<void> } },
    safeArtifactName: string) => Promise<{ size: number; sha512: string }>
}

interface Fixture {
  readonly repositoryRoot: string
  readonly appRoot: string
  readonly artifactsRoot: string
  readonly environment: NodeJS.ProcessEnv
}

/** Only HTTP bytes are scripted; provider tag selection and updater version acceptance execute unchanged. */
class ReleaseExecutor extends ElectronHttpExecutor {
  readonly requests: string[] = []
  constructor(private readonly responses: ReadonlyMap<string, string>) { super() }
  override async request(options: RequestOptions): Promise<string> {
    const path = new URL(options.path ?? '/', 'https://release-fixture.invalid').pathname
    this.requests.push(path)
    const response = this.responses.get(path)
    if (response === undefined) throw new Error(`unconfigured release request ${path}`)
    return response
  }
}

function releaseFeed(tags: readonly string[]): string {
  return `<feed xmlns="http://www.w3.org/2005/Atom">${tags.map(tag => `<entry><title>${tag}</title>`
    + `<link href="https://github.com/felir7at62co-wq/muse-med/releases/tag/${tag}"/><content>Release</content></entry>`).join('')}</feed>`
}

function digest(contents: string): string {
  return createHash('sha512').update(contents).digest('base64')
}

async function fixture(
  target: DesktopPackageTargetName,
  version = '1.2.3',
  environment: 'test' | 'production' = 'test',
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-upload-'))
  temporaryDirectories.push(root)
  const repositoryRoot = join(root, 'repository')
  const appRoot = join(repositoryRoot, 'apps', 'desktop')
  const artifactsRoot = join(appRoot, '.desktop-build', 'artifacts')
  await mkdir(artifactsRoot, { recursive: true })
  await writeFile(join(repositoryRoot, 'package.json'), '{"version":"0.1.7-rc.8"}\n')
  await writeFile(join(appRoot, 'package.json'), '{"version":"0.1.7-rc.8"}\n')
  await writeFile(join(appRoot, 'muse-product.json'), `${JSON.stringify({ version })}\n`)

  const [os, arch] = target.split('-') as ['mac' | 'win', 'arm64' | 'x64']
  const base = `muse-med-${version}-${os}-${arch}`
  const origin = environment === 'test'
    ? TEST_ORIGIN
    : 'https://download.deepseek.com'
  await writeFile(join(artifactsRoot, `${target}-release.json`), `${JSON.stringify({
    schemaVersion: 1,
    target,
    version,
    dshVersion: '0.1.7-rc.8',
    environment,
    publicUrl: `${origin}/dsh-desk/${environment === 'test' ? `${RELEASE_ID}/` : ''}feeds/${target}/`,
  })}\n`)

  if (os === 'mac') {
    const zip = 'signed macOS ZIP fixture'
    await writeFile(join(artifactsRoot, `${base}.zip`), zip)
    await writeFile(join(artifactsRoot, `${base}.zip.blockmap`), 'blockmap')
    await writeFile(join(artifactsRoot, `${base}.dmg`), 'notarized DMG fixture')
    await writeFile(join(artifactsRoot, desktopUpdateMetadataFilename(version, 'darwin')), `${JSON.stringify({
      version,
      path: `${base}.zip`,
      files: [{ url: `${base}.zip`, size: Buffer.byteLength(zip), sha512: digest(zip) }],
    })}\n`)
  }
  else {
    const executable = 'signed NSIS executable fixture'
    await writeFile(join(artifactsRoot, `${base}.exe`), executable)
    const info = await createBlockmap(join(artifactsRoot, `${base}.exe`), {},
      { info: { emitArtifactBuildCompleted: async () => {} } }, `${base}.exe`)
    expect(Object.hasOwn(info, 'blockMapSize')).toBe(false)
    await writeFile(join(artifactsRoot, desktopUpdateMetadataFilename(version, 'win32')), `${JSON.stringify({
      version,
      path: `${base}.exe`,
      files: [{
        url: `${base}.exe`,
        ...info,
      }],
    })}\n`)
  }
  return {
    repositoryRoot,
    appRoot,
    artifactsRoot,
    environment: environment === 'test'
      ? {
        DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
        DOWNLOAD_TEST_ORIGIN: TEST_ORIGIN,
        DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
        DOWNLOAD_TEST_COS_BUCKET: TEST_BUCKET,
      }
      : {
        DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
        DOWNLOAD_PROD_COS_BUCKET: PRODUCTION_BUCKET,
      },
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async path => rm(path, {
    recursive: true,
    force: true,
  })))
})

describe('desktop upload plan', () => {
  it.each([
    ['0.1.7-rc.7', 'rc'], ['0.1.7-rc.7', 'latest'], ['0.1.7-rc.8', 'rc'], ['0.1.7-rc.8', 'latest'],
  ])('lets installed %s with %s configuration discover the genuine Muse beta through its required rc release', async (current, channel) => {
    const paths = await fixture('win-x64', '1.0.0-beta.1')
    await writeFile(join(paths.appRoot, 'muse-product.json'), '{"version":"1.0.0-beta.1","legacyRcDiscovery":true}\n')
    const plan = await createDesktopUploadPlan('win-x64', paths)
    const entries = plan.githubReleases!
    const base = '/felir7at62co-wq/muse-med/releases'
    const responses = new Map([[`${base}.atom`, releaseFeed(entries.map(entry => entry.tag))]])
    for (const entry of entries) for (const metadata of entry.metadataFiles) {
      responses.set(`${base}/download/${entry.tag}/${metadata.filename}`, metadata.contents)
    }
    const executor = new ReleaseExecutor(responses)
    const updater = Object.assign(new NsisUpdater(undefined, {
      version: current, name: 'muse-med', isPackaged: true, appUpdateConfigPath: '/unused',
      userDataPath: paths.repositoryRoot, baseCachePath: paths.repositoryRoot,
      whenReady: async () => {}, relaunch: () => {}, quit: () => {}, onQuit: () => {},
    }), { httpExecutor: executor, _testOnlyOptions: { platform: 'win32' } })
    updater.autoDownload = false
    updater.allowPrerelease = true
    updater.allowDowngrade = false
    updater.logger = null
    updater.setFeedURL({ provider: 'github', owner: 'felir7at62co-wq', repo: 'muse-med', channel })
    const result = await updater.checkForUpdates()
    expect(result?.isUpdateAvailable).toBe(true)
    expect(result?.updateInfo.version).toBe('1.0.0-beta.1')
    expect(result?.updateInfo.files[0]?.url).toBe('muse-med-1.0.0-beta.1-win-x64.exe')
    expect(executor.requests).toContain(`${base}/download/v1.0.0-rc.muse-beta.1/rc.yml`)
    expect(executor.requests).not.toContain(`${base}/download/v1.0.0-beta.1/beta.yml`)
    responses.set(`${base}.atom`, releaseFeed([entries[0]!.tag]))
    await expect(updater.checkForUpdates()).rejects.toThrow(/No published versions on GitHub/u)
  })

  it.each(['rc', 'latest'])('keeps the %s COS feed usable by an installed rc client', async (channel) => {
    const paths = await fixture('win-x64', '1.0.0-beta.1')
    await writeFile(join(paths.appRoot, 'muse-product.json'), '{"version":"1.0.0-beta.1","legacyRcDiscovery":true}\n')
    const plan = await createDesktopUploadPlan('win-x64', paths)
    const responses = new Map(plan.artifacts.filter(artifact => artifact.channelMetadata)
      .map(artifact => [`${new URL(plan.publicUrl).pathname}${artifact.filename}`, artifact.contents!]))
    const updater = Object.assign(new NsisUpdater(undefined, {
      version: '0.1.7-rc.8', name: 'muse-med', isPackaged: true, appUpdateConfigPath: '/unused',
      userDataPath: paths.repositoryRoot, baseCachePath: paths.repositoryRoot,
      whenReady: async () => {}, relaunch: () => {}, quit: () => {}, onQuit: () => {},
    }), { httpExecutor: new ReleaseExecutor(responses), _testOnlyOptions: { platform: 'win32' } })
    updater.autoDownload = false
    updater.allowPrerelease = true
    updater.allowDowngrade = false
    updater.logger = null
    updater.setFeedURL({ provider: 'generic', url: plan.publicUrl, channel })
    const result = await updater.checkForUpdates()
    expect(result?.isUpdateAvailable).toBe(true)
    expect(result?.updateInfo.version).toBe('1.0.0-beta.1')
    expect(result?.updateInfo.files[0]?.url).toContain('/bin/win-x64/muse-med-1.0.0-beta.1-win-x64.exe')
  })

  it.each(['win-x64', 'mac-arm64'] as const)('plans %s beta and legacy rc discovery with identical metadata and binaries', async (target) => {
    const paths = await fixture(target, '1.0.0-beta.1')
    await writeFile(join(paths.appRoot, 'muse-product.json'), '{"version":"1.0.0-beta.1","legacyRcDiscovery":true}\n')
    const plan = await createDesktopUploadPlan(target, paths)
    const suffix = target === 'win-x64' ? '' : '-mac'
    const metadata = plan.artifacts.filter(artifact => artifact.channelMetadata)
    expect(metadata.map(artifact => artifact.filename)).toEqual([`beta${suffix}.yml`, `rc${suffix}.yml`, `latest${suffix}.yml`])
    expect(new Set(metadata.map(artifact => artifact.contents)).size).toBe(1)
    expect(load(metadata[0]!.contents!)).toMatchObject({ version: '1.0.0-beta.1' })
    expect(plan.githubReleases?.map(release => ({ tag: release.tag, version: release.version }))).toEqual([
      { tag: 'v1.0.0-beta.1', version: '1.0.0-beta.1' },
      { tag: 'v1.0.0-rc.muse-beta.1', version: '1.0.0-beta.1' },
    ])
    expect(plan.githubReleases?.[0]?.binaryFilenames).toEqual(plan.githubReleases?.[1]?.binaryFilenames)
  })

  it('publishes the version-derived channel feed referencing versioned binaries without overriding CDN cache policy', async () => {
    const paths = await fixture('win-x64', '1.2.3', 'production')
    const plan = await createDesktopUploadPlan('win-x64', paths)
    expect(plan.artifacts.map(artifact => artifact.key)).toEqual([
      'dsh-desk/bin/win-x64/muse-med-1.2.3-win-x64.exe',
      'dsh-desk/bin/win-x64/muse-med-1.2.3-win-x64.exe.blockmap',
      'dsh-desk/feeds/win-x64/latest.yml',
    ])
    expect(load(plan.artifacts[2]!.contents!)).toMatchObject({
      version: '1.2.3',
      files: [{
        url: 'https://download.deepseek.com/dsh-desk/bin/win-x64/muse-med-1.2.3-win-x64.exe',
        sha512: digest('signed NSIS executable fixture'),
      }],
    })
    expect(plan.artifacts.every(artifact => !('cacheControl' in artifact))).toBe(true)
  })

  it('validates macOS artifacts and puts channel metadata last', async () => {
    const paths = await fixture('mac-arm64')
    const plan = await createDesktopUploadPlan('mac-arm64', paths)
    expect(plan).toMatchObject({
      environment: 'test',
      version: '1.2.3',
      publicUrl: `https://desktop-updates.example.com/dsh-desk/${RELEASE_ID}/feeds/mac-arm64/`,
      bucket: TEST_BUCKET,
    })
    expect(plan.artifacts.map(artifact => artifact.filename)).toEqual([
      'muse-med-1.2.3-mac-arm64.dmg',
      'muse-med-1.2.3-mac-arm64.zip',
      'muse-med-1.2.3-mac-arm64.zip.blockmap',
      'latest-mac.yml',
    ])
    expect(plan.artifacts.at(-1)).toMatchObject({
      channelMetadata: true,
    })
  })

  it.each(['mac-arm64', 'mac-x64', 'win-x64'] as const)('publishes every %s object and YAML reference inside the test release directory', async (target) => {
    const paths = await fixture(target)
    const plan = await createDesktopUploadPlan(target, paths)
    const prefix = `dsh-desk/${RELEASE_ID}`
    const payload = plan.artifacts.find(artifact => artifact.filename.endsWith(target === 'win-x64' ? '.exe' : '.zip'))!
    for (const artifact of plan.artifacts) {
      expect(artifact.key).toBe(`${prefix}/${artifact.channelMetadata ? 'feeds' : 'bin'}/${target}/${artifact.filename}`)
      if (artifact.channelMetadata) {
        expect(load(artifact.contents!)).toMatchObject({
          path: `${TEST_ORIGIN}/${payload.key}`,
          files: [{ url: `${TEST_ORIGIN}/${payload.key}` }],
        })
      }
    }
    await expect(JSON.stringify(plan.artifacts.map(({ key, contents }) => ({ key, contents })), null, 2) + '\n')
      .toMatchFileSnapshot(`./expected/test-release-upload-${target}.json`)
  })

  it('rejects a changed or missing release ID before uploading a completed package', async () => {
    const paths = await fixture('mac-arm64')
    await expect(createDesktopUploadPlan('mac-arm64', {
      ...paths, environment: { ...paths.environment, DOWNLOAD_TEST_RELEASE_ID: 'a'.repeat(32) },
    })).rejects.toThrow(/completion record/u)
    await expect(createDesktopUploadPlan('mac-arm64', {
      ...paths, environment: { ...paths.environment, DOWNLOAD_TEST_RELEASE_ID: undefined },
    })).rejects.toThrow(/DOWNLOAD_TEST_RELEASE_ID/u)
  })

  it('uploads the prerelease channel metadata emitted by electron-builder', async () => {
    const paths = await fixture('mac-arm64', '1.2.3-alpha.4')
    const plan = await createDesktopUploadPlan('mac-arm64', paths)
    expect(plan.artifacts.map(artifact => artifact.filename)).toEqual([
      'muse-med-1.2.3-alpha.4-mac-arm64.dmg',
      'muse-med-1.2.3-alpha.4-mac-arm64.zip',
      'muse-med-1.2.3-alpha.4-mac-arm64.zip.blockmap',
      'alpha-mac.yml',
    ])
  })

  it('validates the Windows installer with the emitted external blockmap and production destination', async () => {
    const paths = await fixture('win-x64', '2.0.0', 'production')
    const plan = await createDesktopUploadPlan('win-x64', paths)
    expect(plan.artifacts.map(artifact => artifact.filename)).toEqual([
      'muse-med-2.0.0-win-x64.exe',
      'muse-med-2.0.0-win-x64.exe.blockmap',
      'latest.yml',
    ])
    expect(plan).toMatchObject({
      publicUrl: 'https://download.deepseek.com/dsh-desk/feeds/win-x64/',
      bucket: PRODUCTION_BUCKET,
    })
  })

  it.each(['missing', 'empty'])('rejects a %s Windows blockmap before publishing its feed', async (condition) => {
    const paths = await fixture('win-x64')
    const path = join(paths.artifactsRoot, 'muse-med-1.2.3-win-x64.exe.blockmap')
    if (condition === 'missing') await rm(path)
    else await writeFile(path, '')
    await expect(createDesktopUploadPlan('win-x64', paths)).rejects.toThrow(/missing or empty artifact.*\.exe\.blockmap/u)
  })

  it('rejects a completed build from another dsh version or deployment', async () => {
    const paths = await fixture('mac-x64')
    await writeFile(join(paths.repositoryRoot, 'package.json'), '{"version":"1.2.4"}\n')
    await writeFile(join(paths.appRoot, 'package.json'), '{"version":"1.2.4"}\n')
    await expect(createDesktopUploadPlan('mac-x64', paths)).rejects.toThrow(/completion record.*1\.2\.4/u)

    const productionPaths = await fixture('mac-x64', '1.2.3', 'production')
    await expect(createDesktopUploadPlan('mac-x64', {
      ...productionPaths,
      environment: {
        DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
        DOWNLOAD_TEST_ORIGIN: TEST_ORIGIN,
        DOWNLOAD_TEST_RELEASE_ID: RELEASE_ID,
        DOWNLOAD_TEST_COS_BUCKET: TEST_BUCKET,
      },
    })).rejects.toThrow(/completion record.*test/u)
  })

  it('rejects a completion record from a different Muse release even when the harness version matches', async () => {
    const paths = await fixture('mac-arm64', '1.0.0-beta.1')
    await writeFile(join(paths.appRoot, 'muse-product.json'), '{"version":"1.0.0-beta.2"}\n')
    await expect(createDesktopUploadPlan('mac-arm64', paths)).rejects.toThrow(/not a build of Muse 1\.0\.0-beta\.2/u)
  })

  it('rejects stale architecture metadata and modified updater bytes', async () => {
    const paths = await fixture('mac-arm64')
    const metadataPath = join(paths.artifactsRoot, desktopUpdateMetadataFilename('1.2.3', 'darwin'))
    const zipPath = join(paths.artifactsRoot, 'muse-med-1.2.3-mac-arm64.zip')
    await writeFile(zipPath, 'modified')
    await expect(createDesktopUploadPlan('mac-arm64', paths)).rejects.toThrow(/size.*metadata/u)

    const x64 = 'wrong architecture'
    await writeFile(metadataPath, `${JSON.stringify({
      version: '1.2.3',
      files: [{
        url: 'muse-med-1.2.3-mac-x64.zip',
        size: Buffer.byteLength(x64),
        sha512: digest(x64),
      }],
    })}\n`)
    await expect(createDesktopUploadPlan('mac-arm64', paths)).rejects.toThrow(/mac-arm64\.zip/u)
  })
})
