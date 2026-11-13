/** Exercise the actual Desktop coordinator with offline updater sources. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const desktop = new URL('../../../apps/desktop/', import.meta.url).href
const mocks = {
  electron: 'export const app={isPackaged:false,getVersion:()=>"1.0.0"}; export const shell={};',
  'electron-updater': 'export default {autoUpdater:{},AppUpdater:class{}};',
  'electron-updater/out/electronHttpExecutor.js': 'export class ElectronHttpExecutor {}',
}
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(desktop) && Object.hasOwn(mocks, specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
let DesktopUpdateCoordinator
try {
  ;({ DesktopUpdateCoordinator } = await importSnapshotModule(
    new URL('../../../apps/desktop/src/update-coordinator.ts', import.meta.url),
    new URL('../../../apps/desktop/lib/types/update-coordinator.js', import.meta.url)))
} finally { hooks.deregister() }

const sources = [
  { provider: 'generic', url: 'https://update.invalid/', channel: 'latest' },
  { provider: 'github', owner: 'example', repo: 'offline', channel: 'latest' },
]
const info = { version: '1.1.0', files: [{ url: 'offline.exe', sha512: Buffer.alloc(64, 1).toString('base64'), size: 42 }] }
const offline = () => Object.assign(new Error('offline source'), { code: 'ETIMEDOUT' })

async function scenario(retry) {
  const updater = new EventEmitter()
  let source = '', primaryChecks = 0, fallbackChecks = 0, calls = 0, successful = 0, installs = 0
  Object.assign(updater, {
    setFeedURL(value) { source = value.provider === 'github' ? 'fallback' : 'primary' },
    async checkForUpdates() {
      if (source === 'primary') {
        primaryChecks++
        if (primaryChecks > 1 && retry === 'fallback') throw offline()
        const changed = structuredClone(info)
        if (primaryChecks > 1 && retry === 'version') changed.version = '1.2.0'
        if (primaryChecks > 1 && retry === 'size') changed.files[0].size++
        if (primaryChecks > 1 && retry === 'sha512') changed.files[0].sha512 = Buffer.alloc(64, 2).toString('base64')
        return { isUpdateAvailable: true, updateInfo: changed }
      }
      fallbackChecks++
      return fallbackChecks === 1
        ? { isUpdateAvailable: false, updateInfo: { ...info, version: '1.0.0' } }
        : { isUpdateAvailable: true, updateInfo: info }
    },
    async downloadUpdate() {
      calls++
      if (calls === 1) throw offline()
      successful++
      updater.emit('update-downloaded', info)
      return ['offline-verified-package']
    },
    quitAndInstall() { installs++ },
    autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false, allowDowngrade: false,
  })
  const coordinator = new DesktopUpdateCoordinator(state => state, async () => true, updater, () => true,
    () => '1.0.0', undefined, sources, 'win32')
  try {
    const first = await coordinator.check(true)
    assert.deepEqual(first, { phase: 'available', version: info.version })
    const refused = await coordinator.download(info.version)
    assert.equal(refused.phase, 'error')
    assert.equal(refused.failedOperation, 'download')
    const after = await coordinator.download(info.version)
    if (['version', 'size', 'sha512'].includes(retry)) {
      assert.equal(after.phase, 'error')
      assert.equal(successful, 0)
      await assert.rejects(coordinator.install(info.version), /not ready/)
    } else {
      assert.deepEqual(after, { phase: 'ready', version: info.version })
      assert.equal(source, retry === 'fallback' ? 'fallback' : 'primary')
      assert.equal(successful, 1)
    }
    assert.equal(primaryChecks, 2)
    assert.equal(installs, 0)
    return { calls, successful, installs }
  } finally { coordinator.dispose() }
}

export const inject = ['tools', 'agents']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Real Headless session context. */
export function apply(ctx) {
  let completed = false
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'read') return next()
    assert.equal(completed, false)
    assert.ok(exec.agent)
    assert.deepEqual(exec.arguments, { file_path: 'update-retry-proof.json' })
    const primary = await scenario('primary')
    const fallback = await scenario('fallback')
    const changed = await Promise.all(['version', 'size', 'sha512'].map(scenario))
    const proof = { initialOfferConfirmed: true, staleFallbackRefused: true,
      matchingFallbackSucceeded: fallback.successful === 1, recoveredPrimaryDownloads: primary.successful,
      changedIdentityRejected: changed.every(item => item.successful === 0),
      unverifiedDownloads: changed.reduce((sum, item) => sum + item.successful, 0),
      installerInvocations: [primary, fallback, ...changed].reduce((sum, item) => sum + item.installs, 0) }
    await writeFile(join(exec.agent.session.header.cwd, 'update-retry-proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
    completed = true
    return next()
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (completed) {
      const text = options.messages.filter(message => message.role === 'tool')
        .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.match(text, /"matchingFallbackSucceeded": true/)
      assert.match(text, /"changedIdentityRejected": true/)
      const cwd = ctx.agents.get(options.sessionId).session.header.cwd
      const proof = JSON.parse(await readFile(join(cwd, 'update-retry-proof.json'), 'utf8'))
      assert.equal(proof.recoveredPrimaryDownloads, 1)
      assert.equal(proof.unverifiedDownloads, 0)
      assert.equal(proof.installerInvocations, 0)
    }
    yield* next()
  })
}
