/** Real Electron HTTPS/DMG qualification; application installation and Finder opening are intercepted. */
import assert from 'node:assert/strict'
import { X509Certificate, createHash } from 'node:crypto'
import { createServer } from 'node:https'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, autoUpdater as nativeUpdater, shell } from 'electron'
import { getNetSession } from 'electron-updater/out/electronHttpExecutor.js'
import { createMacOSManualUpdater } from '../../lib/types/macos-manual-updater.js'
import { DesktopUpdateCoordinator } from '../../lib/types/update-coordinator.js'
import { DesktopUpdateHttpExecutor } from '../../lib/types/update-http-executor.js'

const root = process.env.DSH_MACOS_MANUAL_UPDATE_ROOT
if (!root) throw new Error('Manual macOS qualification requires its private root')
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
process.on('unhandledRejection', error => { console.error(error); app.exit(1) })
app.setPath('userData', join(root, 'electron-profile'))
async function main() {
  await app.whenReady()
  const certificate = await readFile(join(root, 'certificate.pem'))
  const fingerprint = new X509Certificate(certificate).fingerprint256
  const updateSession = getNetSession()
  updateSession.setCertificateVerifyProc((request, callback) => {
    callback(request.hostname === '127.0.0.1' && new X509Certificate(request.certificate.data).fingerprint256 === fingerprint ? 0 : -3)
  })
  const valid = await readFile(join(root, 'valid.dmg'))
  const invalid = await readFile(join(root, 'invalid.dmg'))
  const sha512 = body => createHash('sha512').update(body).digest('base64')
  const name = `muse-med-1.0.4-mac-${process.arch}.dmg`
  const requests = []
  let origin
  const server = createServer({ key: await readFile(join(root, 'key.pem')), cert: certificate }, (request, response) => {
    requests.push(request.url)
    const [lane, filename] = new URL(request.url, origin).pathname.slice(1).split('/')
    const body = lane === 'invalid' ? invalid : valid
    if (filename === 'latest-mac.yml') {
      const advertised = lane === 'wrong-arch' ? `muse-med-1.0.4-mac-${process.arch === 'arm64' ? 'x64' : 'arm64'}.dmg` : name
      response.end(`version: 1.0.4\nfiles:\n  - url: ${origin}/${lane}/${advertised}\n    sha512: ${sha512(body)}\n    size: ${body.length}\npath: ${advertised}\nsha512: ${sha512(body)}\nreleaseDate: 2026-10-07T00:00:00.000Z\n`)
    } else if (filename === name) {
      response.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/x-apple-diskimage' })
      response.end(lane === 'corrupt' ? Buffer.alloc(body.length) : body)
    } else { response.writeHead(404); response.end() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Private updater server did not expose a port')
  origin = `https://127.0.0.1:${address.port}`
  const native = { check: 0, install: 0 }
  nativeUpdater.checkForUpdates = () => { native.check++; throw new Error('Manual updater invoked Squirrel') }
  nativeUpdater.quitAndInstall = () => { native.install++; throw new Error('Manual updater invoked Squirrel') }
  const outcomes = []
  const coordinators = []
  let openFailure = ''
  const opened = []
  shell.openPath = async path => { opened.push(path); return openFailure }
  function phase(state, expected) { assert.equal(state.phase, expected, JSON.stringify(state)) }

  async function fixture(lane) {
    const directory = join(root, `case-${coordinators.length}`)
    await mkdir(join(directory, 'data'), { recursive: true })
    await mkdir(join(directory, 'cache'))
    const config = join(directory, 'app-update.yml')
    await writeFile(config, `provider: generic\nurl: ${origin}/${lane}/\nupdaterCacheDirName: muse-qualification\n`)
    let quits = 0
    let authorized = false
    let inspections = 0
    const adapter = { version: '1.0.3', name: 'muse-med', isPackaged: true, appUpdateConfigPath: config,
      userDataPath: join(directory, 'data'), baseCachePath: join(directory, 'cache'), whenReady: async () => undefined,
      relaunch() { throw new Error('Manual update relaunched the application') }, quit() { quits++ }, onQuit() {} }
    const updater = createMacOSManualUpdater('cn.muse.med', adapter)
    updater.httpExecutor = new DesktopUpdateHttpExecutor(60_000)
    updater.logger = null
    const states = []
    const coordinator = new DesktopUpdateCoordinator(state => { states.push(state); return state },
      async () => { inspections++; return authorized }, updater, () => true, () => adapter.version, undefined,
      [{ provider: 'generic', url: `${origin}/${lane}/`, channel: 'latest', useMultipleRangeRequest: false }])
    coordinators.push(coordinator)
    const checked = await coordinator.check(true)
    assert.equal(checked.phase, 'available', checked.message)
    return { coordinator, updater, states, directory, authorize: () => { authorized = true },
      quits: () => quits, inspections: () => inspections }
  }

  try {
    const good = await fixture('valid')
    phase(await good.coordinator.download('1.0.4'), 'ready')
    assert.equal(opened.length, 0)
    assert.equal(good.quits(), 0)
    phase(await good.coordinator.install('1.0.4'), 'ready')
    assert.equal(opened.length, 0)
    good.authorize()
    phase(await good.coordinator.install('1.0.4'), 'installing')
    assert.equal(opened.length, 1)
    assert.equal(good.quits(), 1)
    assert.equal(sha512(await readFile(opened[0])), sha512(valid))
    outcomes.push({ scenario: 'verified-download-deferral-and-explicit-open', pass: true })

    const opener = await fixture('valid')
    phase(await opener.coordinator.download('1.0.4'), 'ready')
    opener.authorize()
    openFailure = 'fixture refused installer opening'
    assert.equal((await opener.coordinator.install('1.0.4')).failedOperation, 'install')
    assert.equal(opener.quits(), 0)
    openFailure = ''
    outcomes.push({ scenario: 'installer-open-failure-retains-application', pass: true })

    const tamper = await fixture('valid')
    phase(await tamper.coordinator.download('1.0.4'), 'ready')
    const cached = join(tamper.directory, 'cache', 'muse-qualification', 'pending', name)
    await writeFile(cached, Buffer.alloc(valid.length))
    tamper.authorize()
    assert.equal((await tamper.coordinator.install('1.0.4')).failedOperation, 'download')
    assert.equal(tamper.inspections(), 0)
    phase(await tamper.coordinator.download('1.0.4'), 'ready')
    outcomes.push({ scenario: 'cache-tamper-before-task-stop-and-explicit-redownload', pass: true })

    for (const lane of ['corrupt', 'invalid', 'wrong-arch']) {
      const rejected = await fixture(lane)
      const state = await rejected.coordinator.download('1.0.4')
      assert.equal(state.phase, 'error')
      assert.equal(state.failedOperation, 'download')
      assert.equal(rejected.inspections(), 0)
      assert.equal(rejected.quits(), 0)
      outcomes.push({ scenario: `${lane}-package-refused`, pass: true })
    }
    assert.deepEqual(native, { check: 0, install: 0 })
    const result = { pass: true, scenarios: outcomes, requests, nativeSquirrelCalls: native,
      interceptedInstallerOpening: true, installedApplicationModified: false, actualHostTaskTeardown: false }
    await writeFile(join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    console.log('MACOS_MANUAL_UPDATER_RESULT', JSON.stringify(result))
  } finally {
    for (const coordinator of coordinators) coordinator.dispose()
    await updateSession.closeAllConnections()
    server.closeAllConnections()
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
    updateSession.setCertificateVerifyProc(null)
  }
}
void main().then(() => { app.exit(0) }).catch(error => { console.error(error); app.exit(1) })
