import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { RequestOptions } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NsisUpdater } from 'electron-updater/out/NsisUpdater.js'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUpdateSource } from '../src/update-sources.ts'
import type { DesktopUpdateState } from '../src/ipc.ts'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))

const { DesktopUpdateCoordinator } = await import('../src/update-coordinator.ts')
const base = '/felir7at62co-wq/muse-med/releases'
const stable = '1.0.4'
const beta = '1.0.5-beta.1'
const runtimeTag = 'hongguo-source-runtime-9869b8571b45'
const rcTag = `v${stable}-rc.muse-stable`
const roots: string[] = []
const coordinators: InstanceType<typeof DesktopUpdateCoordinator>[] = []

/** HTTP responses are scripted; the pinned updater selects tags and checks versions. */
class ReleaseExecutor extends ElectronHttpExecutor {
  readonly requests: string[] = []
  readonly downloads: string[] = []
  readonly downloadResponses = new Map<string, string | Error>()
  constructor(private readonly responses: ReadonlyMap<string, string>) { super() }
  override async request(options: RequestOptions): Promise<string> {
    const path = new URL(options.path ?? '/', 'https://release-fixture.invalid').pathname
    this.requests.push(path)
    const response = this.responses.get(path)
    if (response === undefined) throw new Error(`unconfigured release request ${path}`)
    return response
  }
  override async download(url: URL, destination: string): Promise<string> {
    this.downloads.push(url.href)
    const response = this.downloadResponses.get(url.href)
    if (response === undefined) throw new Error(`unconfigured release download ${url.href}`)
    if (response instanceof Error) throw response
    await writeFile(destination, response)
    return destination
  }
}

function metadata(version: string, payload = 'inert updater fixture'): string {
  const filename = `muse-med-${version}-win-x64.exe`
  return JSON.stringify({ version, path: filename, files: [{ url: filename, size: Buffer.byteLength(payload),
    sha512: createHash('sha512').update(payload).digest('base64') }] })
}

function releaseFeed(tags: readonly string[]): string {
  return `<feed xmlns="http://www.w3.org/2005/Atom">${tags.map(tag => `<entry><title>${tag}</title>`
    + `<link href="https://github.com/felir7at62co-wq/muse-med/releases/tag/${tag}"/><content>Release</content></entry>`).join('')}</feed>`
}

async function fixture(version: string, channel: string, sources: readonly DesktopUpdateSource[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'muse-updater-discovery-'))
  roots.push(root)
  await writeFile(join(root, 'unused.yml'), JSON.stringify({ updaterCacheDirName: 'updater-cache' }))
  const tags = [runtimeTag, `v${beta}`, rcTag, `v${stable}`]
  const responses = new Map([
    [`${base}.atom`, releaseFeed(tags)],
    [`${base}/latest`, JSON.stringify({ tag_name: `v${stable}` })],
    [`${base}/download/v${stable}/latest.yml`, metadata(stable)],
    [`${base}/download/${rcTag}/rc.yml`, metadata(stable)],
    [`${base}/download/v${beta}/beta.yml`, metadata(beta)],
  ])
  const executor = new ReleaseExecutor(responses)
  const forbidden = () => { throw new Error('Update discovery must not quit or relaunch') }
  const updater = Object.assign(new NsisUpdater(undefined, {
    version, name: 'muse-med', isPackaged: true, appUpdateConfigPath: join(root, 'unused.yml'),
    userDataPath: root, baseCachePath: root, whenReady: async () => {}, relaunch: forbidden,
    quit: forbidden, onQuit: () => {},
  }), { httpExecutor: executor, _testOnlyOptions: { platform: 'win32' } })
  updater.logger = null
  updater.disableDifferentialDownload = true
  updater.setFeedURL({ provider: 'github', owner: 'felir7at62co-wq', repo: 'muse-med', channel })
  const states: DesktopUpdateState[] = []
  const coordinator = new DesktopUpdateCoordinator((state) => { states.push(state); return state }, async () => {
    throw new Error('Update discovery must not prepare installation')
  }, updater, () => true, () => version, undefined, sources)
  coordinators.push(coordinator)
  return { coordinator, updater, executor, responses, root, states }
}

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Muse GitHub updater discovery', () => {
  it.each(['1.0.1', '1.0.3'])('keeps stable %s on the stable application release despite newer runtime and beta entries', async (version) => {
    const f = await fixture(version, 'latest')
    expect(await f.coordinator.check(true)).toMatchObject({ phase: 'available', version: stable })
    expect(f.updater.allowPrerelease).toBe(false)
    expect(f.updater.allowDowngrade).toBe(false)
    expect(f.executor.requests).toEqual([`${base}.atom`, `${base}/latest`, `${base}/download/v${stable}/latest.yml`])
  })

  it.each(['rc', 'latest'])('retains legacy RC discovery through packaged %s metadata', async (channel) => {
    const f = await fixture('0.1.7-rc.8', channel)
    expect(await f.coordinator.check(true)).toMatchObject({ phase: 'available', version: stable })
    expect(f.updater.allowPrerelease).toBe(true)
    expect(f.updater.allowDowngrade).toBe(false)
    expect(f.executor.requests).toEqual([`${base}.atom`, `${base}/download/${rcTag}/rc.yml`])
  })

  it('retains beta discovery and excludes non-semantic runtime tags', async () => {
    const f = await fixture('1.0.4-beta.1', 'beta')
    expect(await f.coordinator.check(true)).toMatchObject({ phase: 'available', version: beta })
    expect(f.updater.allowPrerelease).toBe(true)
    expect(f.executor.requests).toEqual([`${base}.atom`, `${base}/download/v${beta}/beta.yml`])
  })

  it('reports unavailable stable metadata without substituting a runtime or beta release', async () => {
    const f = await fixture('1.0.3', 'latest')
    f.responses.delete(`${base}/download/v${stable}/latest.yml`)
    expect(await f.coordinator.check(true)).toMatchObject({ phase: 'error', failedOperation: 'check' })
    expect(f.executor.requests).toEqual([`${base}.atom`, `${base}/latest`, `${base}/download/v${stable}/latest.yml`])
    expect(f.coordinator.state).not.toHaveProperty('version')
  })

  it('lets the original stable client discover genuine metadata when the RC alias is published last', async () => {
    const f = await fixture('1.0.1', 'latest')
    // Released 1.0.1 uses first-entry discovery until the new package replaces its coordinator.
    f.updater.allowPrerelease = true
    f.responses.set(`${base}.atom`, releaseFeed([rcTag, `v${stable}`, runtimeTag]))
    expect(await f.coordinator.check(true)).toMatchObject({ phase: 'available', version: stable })
    expect(f.executor.requests).toEqual([`${base}.atom`, `${base}/download/${rcTag}/rc.yml`])
  })
})


describe('Muse updater mirror download retries', () => {
  it.each(['other updater fixture', 'changed updater fixture'])('keeps changed fallback bytes blocked across retries: %s', async (changed) => {
    const sources: readonly DesktopUpdateSource[] = [
      { provider: 'generic', url: 'https://mirror.example.com/primary/', channel: 'latest' },
      { provider: 'github', owner: 'felir7at62co-wq', repo: 'muse-med', channel: 'latest' },
    ]
    const f = await fixture('1.0.3', 'latest', sources)
    const filename = `muse-med-${stable}-win-x64.exe`
    const primary = `https://mirror.example.com/primary/${filename}`
    const fallback = `https://github.com${base}/download/v${stable}/${filename}`
    f.responses.set('/primary/latest.yml', metadata(stable))
    f.responses.set(`${base}/download/v${stable}/latest.yml`, metadata(stable, changed))
    f.executor.downloadResponses.set(primary, Object.assign(new Error('unavailable'), { statusCode: 503 }))
    f.executor.downloadResponses.set(fallback, changed)
    expect(await f.coordinator.check(true)).toMatchObject({ phase: 'available', version: stable })
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await f.coordinator.download(stable)).toMatchObject({ phase: 'error', failedOperation: 'download' })
      await expect(f.coordinator.install(stable)).rejects.toThrow(/not ready/u)
    }
    expect(f.executor.downloads).toEqual([primary])
    f.responses.set(`${base}/download/v${stable}/latest.yml`, metadata(stable))
    f.executor.downloadResponses.set(fallback, 'inert updater fixture')
    expect(await f.coordinator.download(stable)).toMatchObject({ phase: 'ready', version: stable })
    expect(f.executor.downloads).toEqual([primary, fallback])
    expect(await readFile(join(f.root, 'updater-cache', 'pending', filename), 'utf8')).toBe('inert updater fixture')
    await expect(JSON.stringify(f.states, null, 2) + '\n').toMatchFileSnapshot('./expected/update-mirror-retries.json')
  })
})
