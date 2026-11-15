/** Observe the real Desktop update state machine through a recorded Session. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

// The updater transport and Electron are external to the Headless test process.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: 'data:text/javascript,export const app={isPackaged:false};export const shell={}', shortCircuit: true }
    if (specifier === 'electron-updater') return { url: 'data:text/javascript,export default {autoUpdater:{}}', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
let DesktopUpdateCoordinator, DesktopUpdateSchedule, presentDesktopUpdate
try {
  ;({ DesktopUpdateCoordinator } = await importSnapshotModule(
    new URL('../../../apps/desktop/src/update-coordinator.ts', import.meta.url),
    new URL('../../../apps/desktop/lib/types/update-coordinator.js', import.meta.url)))
  ;({ DesktopUpdateSchedule } = await importSnapshotModule(
    new URL('../../../apps/desktop/src/update-schedule.ts', import.meta.url),
    new URL('../../../apps/desktop/lib/types/update-schedule.js', import.meta.url)))
  ;({ presentDesktopUpdate } = await importSnapshotModule(
    new URL('../../../apps/desktop/src/update-presentation.ts', import.meta.url),
    new URL('../../../apps/desktop/lib/types/update-presentation.js', import.meta.url)))
} finally { hooks.deregister() }

export const name = 'snapshot-update-silent'
export const inject = ['tools', 'agents']

async function probe() {
  const version = '1.1.0-nightly.1', events = new EventEmitter(), states = []
  let checks = 0, downloads = 0
  const updater = Object.assign(events, {
    setFeedURL() {}, quitAndInstall() {},
    async checkForUpdates() {
      if (++checks === 2) throw new Error('test feed unavailable')
      return { isUpdateAvailable: true, updateInfo: { version } }
    },
    async downloadUpdate() { downloads++; events.emit('update-downloaded', { version }); return ['verified'] },
  })
  const coordinator = new DesktopUpdateCoordinator(state => { states.push(state); return state },
    async () => false, updater, () => true, () => '1.0.0')
  const schedule = new DesktopUpdateSchedule(coordinator, { intervalMs: 10_000, maxBackoffMs: 40_000, jitter: 0 }, () => 0.5)
  try {
    const initial = await schedule.check()
    const failed = await schedule.check(false, true)
    const visible = presentDesktopUpdate(coordinator.state)
    const manual = await schedule.check(true)
    const downloaded = await coordinator.download(version)
    assert.equal(initial.phase, 'available')
    assert.equal(failed.phase, 'error')
    assert.deepEqual(visible, { phase: 'idle' })
    assert.equal(manual.phase, 'available')
    assert.equal(downloaded.phase, 'ready')
    assert.equal(downloads, 1)
    return { initialOffer: initial.version, automaticCheck: failed.phase, visibleAfterFailure: visible.phase,
      manualRecheck: manual.phase, authorizedDownload: downloaded.phase, downloadRequests: downloads }
  } finally { schedule.dispose(); coordinator.dispose() }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless context. */
export function apply(ctx) {
  let completed = false
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'read') return next()
    assert.equal(completed, false)
    assert.ok(exec.agent)
    assert.deepEqual(exec.arguments, { file_path: 'update-silent-proof.json' })
    const proof = await probe()
    await writeFile(join(exec.agent.session.header.cwd, 'update-silent-proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
    completed = true
    return next()
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (completed) {
      const text = options.messages.filter(message => message.role === 'tool')
        .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.match(text, /"visibleAfterFailure": "idle"/)
      assert.match(text, /"authorizedDownload": "ready"/)
      const cwd = ctx.agents.get(options.sessionId).session.header.cwd
      const saved = JSON.parse(await readFile(join(cwd, 'update-silent-proof.json'), 'utf8'))
      assert.equal(saved.downloadRequests, 1)
    }
    yield* next()
  })
}
