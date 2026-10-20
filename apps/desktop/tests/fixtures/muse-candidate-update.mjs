/** Real candidate installer transport and native verification; installation and public feeds remain untouched. */
import assert from 'node:assert/strict'
import { X509Certificate, createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import updaterModule from 'electron-updater'
import { getNetSession } from 'electron-updater/out/electronHttpExecutor.js'
import { dump } from 'js-yaml'
import { DesktopUpdateCoordinator } from '../../lib/types/update-coordinator.js'
import { DesktopUpdateHttpExecutor } from '../../lib/types/update-http-executor.js'
import { createMacOSManualUpdater } from '../../lib/types/macos-manual-updater.js'

const root = process.env.MUSE_CANDIDATE_UPDATE_ROOT
assert.ok(root, 'Candidate update fixture requires a private launcher root')
app.setPath('userData', join(root, 'electron-profile'))
app.setPath('sessionData', join(root, 'electron-session'))
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
process.on('unhandledRejection', error => { console.error(error); app.exit(1) })

async function fileDigest(path) {
  const sha256 = createHash('sha256'), sha512 = createHash('sha512')
  let size = 0
  for await (const chunk of createReadStream(path)) { size += chunk.length; sha256.update(chunk); sha512.update(chunk) }
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

async function main() {
  await app.whenReady()
  const spec = JSON.parse(await readFile(join(root, 'spec.json'), 'utf8'))
  const report = { schemaVersion: 1, success: false, target: spec.target, version: spec.version,
    fromVersion: spec.fromVersion, sourceCommit: spec.sourceCommit, actualInstallerBytes: true,
    productionCoordinator: true, productionHttpExecutor: true, publicFeedPublished: false,
    productGuiLaunched: false, installerExecuted: false, installedApplicationChanged: false,
    nativeMacDmgVerification: false, publisherSignatureVerified: false, cases: [], requests: [] }
  const persist = () => writeFile(join(spec.output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  const certificate = await readFile(join(root, 'certificate.pem'))
  const fingerprint = new X509Certificate(certificate).fingerprint256
  const netSession = getNetSession()
  netSession.setCertificateVerifyProc((request, callback) => {
    callback(request.hostname === '127.0.0.1'
      && new X509Certificate(request.certificate.data).fingerprint256 === fingerprint ? 0 : -3)
  })
  let origin
  let disconnects = 0
  const streams = new Set()
  const failures = []
  const server = createServer({ key: await readFile(join(root, 'key.pem')), cert: certificate }, (request, response) => {
    const url = new URL(request.url, origin)
    const [lane, filename] = url.pathname.slice(1).split('/')
    const observation = { lane, filename, status: 0, bytes: 0 }
    report.requests.push(observation)
    response.setHeader('Cache-Control', 'no-store')
    const operation = (async () => {
      const expectedChannel = spec.target === 'mac-arm64' ? 'latest-mac.yml' : 'latest.yml'
      if (!['recover', 'bad-hash', 'same-version', 'wrong-arch'].includes(lane)) { observation.status = 404; response.writeHead(404).end(); return }
      if (filename === expectedChannel) {
        const metadata = structuredClone(spec.metadata)
        if (lane === 'bad-hash') {
          for (const file of metadata.files) if (file.url === spec.payload.filename) file.sha512 = createHash('sha512').update('incorrect candidate hash').digest('base64')
          if (metadata.path === spec.payload.filename) metadata.sha512 = metadata.files[0].sha512
        }
        if (lane === 'wrong-arch') {
          for (const file of metadata.files) if (file.url.endsWith('.dmg')) file.url = file.url.replace('-arm64.dmg', '-x64.dmg')
        }
        observation.status = 200
        response.setHeader('Content-Type', 'application/yaml')
        response.end(dump(metadata, { lineWidth: -1, noRefs: true }))
        return
      }
      if (filename !== spec.payload.filename) { observation.status = 404; response.writeHead(404).end(); return }
      observation.status = 200
      response.writeHead(200, { 'Content-Length': spec.payload.size, 'Content-Type': 'application/octet-stream' })
      if (lane === 'recover' && disconnects++ === 0) {
        for await (const bytes of createReadStream(join(spec.artifactsRoot, spec.payload.filename), { start: 0, end: 64 * 1024 - 1 })) {
          observation.bytes += bytes.length
          await new Promise(accept => response.write(bytes, accept))
        }
        response.destroy()
        return
      }
      const stream = createReadStream(join(spec.artifactsRoot, spec.payload.filename))
      stream.on('data', bytes => { observation.bytes += bytes.length })
      await pipeline(stream, response)
    })().catch(error => { failures.push(error.code ?? error.name); response.destroy() })
    streams.add(operation)
    void operation.finally(() => streams.delete(operation))
  })
  const fixtures = []
  try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
    const address = server.address()
    assert.ok(address !== null && typeof address !== 'string')
    origin = `https://127.0.0.1:${address.port}`
    async function fixture(lane, currentVersion = spec.fromVersion) {
      const directory = join(root, `case-${fixtures.length}`)
      await mkdir(directory)
      const config = join(directory, 'app-update.yml')
      await writeFile(config, 'updaterCacheDirName: candidate-cache\n')
      let installerCalls = 0
      let downloadedFile
      const forbidden = () => { installerCalls++; throw new Error('Candidate update must not quit, relaunch or execute an installer') }
      const adapter = { version: currentVersion, name: 'muse-med', isPackaged: true, appUpdateConfigPath: config,
        userDataPath: directory, baseCachePath: directory, whenReady: async () => undefined,
        quit: forbidden, relaunch: forbidden, onQuit() {} }
      const updater = process.platform === 'darwin' ? createMacOSManualUpdater('cn.muse.med', adapter)
        : new updaterModule.NsisUpdater(undefined, adapter)
      updater.logger = null
      updater.httpExecutor = new DesktopUpdateHttpExecutor(60_000)
      if (process.platform === 'win32') { updater.disableDifferentialDownload = true; updater.disableWebInstaller = true }
      updater.on('update-downloaded', event => { downloadedFile = event.downloadedFile })
      const states = []
      const coordinator = new DesktopUpdateCoordinator(state => { states.push(state); return state }, async () => false,
        updater, () => true, () => currentVersion, undefined,
        [{ provider: 'generic', url: `${origin}/${lane}/`, channel: 'latest', useMultipleRangeRequest: false }])
      const result = { lane, coordinator, updater, states, downloadedFile: () => downloadedFile, installerCalls: () => installerCalls }
      fixtures.push(result)
      return result
    }
    await persist()
    const same = await fixture('same-version', spec.version)
    assert.equal((await same.coordinator.check(true)).phase, 'idle')
    assert.equal(same.downloadedFile(), undefined)
    report.cases.push({ name: 'current-version-does-not-download', passed: true })
    const bad = await fixture('bad-hash')
    assert.equal((await bad.coordinator.check(true)).phase, 'available')
    const badHash = await bad.coordinator.download(spec.version)
    assert.equal(badHash.phase, 'error')
    assert.equal(badHash.failedOperation, 'download')
    assert.equal(bad.downloadedFile(), undefined)
    assert.ok(!bad.states.some(state => state.phase === 'ready'))
    await assert.rejects(bad.coordinator.install(spec.version), /not ready/u)
    report.cases.push({ name: 'actual-installer-wrong-sha512-rejected', passed: true })
    await persist()
    if (process.platform === 'darwin') {
      const wrongArch = await fixture('wrong-arch')
      assert.equal((await wrongArch.coordinator.check(true)).phase, 'available')
      assert.equal((await wrongArch.coordinator.download(spec.version)).phase, 'error')
      assert.equal(wrongArch.downloadedFile(), undefined)
      assert.equal(report.requests.filter(entry => entry.lane === 'wrong-arch' && entry.filename.endsWith('.dmg')).length, 0)
      report.cases.push({ name: 'wrong-architecture-dmg-metadata-rejected', passed: true })
    }
    const recovery = await fixture('recover')
    const available = await recovery.coordinator.check(true)
    assert.equal(available.phase, 'available')
    assert.equal(available.version, spec.version)
    assert.equal(report.requests.filter(entry => entry.lane === 'recover' && entry.filename === spec.payload.filename).length, 0)
    const interrupted = await recovery.coordinator.download(spec.version)
    assert.equal(interrupted.phase, 'error')
    assert.equal(interrupted.failedOperation, 'download')
    assert.equal(recovery.downloadedFile(), undefined)
    assert.ok(!recovery.states.some(state => state.phase === 'ready'))
    const partial = report.requests.find(entry => entry.lane === 'recover' && entry.filename === spec.payload.filename)
    assert.ok(partial.bytes > 0 && partial.bytes < spec.payload.size)
    const requestCount = report.requests.length
    await recovery.coordinator.check()
    assert.equal(report.requests.length, requestCount, 'Automatic check must not retry a failed candidate download')
    report.cases.push({ name: 'partial-real-installer-download-fails-without-automatic-retry', passed: true, bytes: partial.bytes })
    await persist()
    assert.equal((await recovery.coordinator.download(spec.version)).phase, 'ready')
    assert.equal(typeof recovery.downloadedFile(), 'string')
    const { filename, ...identity } = spec.payload
    const downloaded = await fileDigest(recovery.downloadedFile())
    assert.deepEqual(downloaded, identity)
    assert.ok(recovery.states.some(state => state.phase === 'downloading'))
    assert.ok(recovery.states.some(state => state.phase === 'ready'))
    if (process.platform === 'darwin') {
      await recovery.updater.verifyPreparedUpdate()
      report.nativeMacDmgVerification = { passed: true, readOnlyMount: true, completeSignature: true,
        identity: 'cn.muse.med', version: spec.version, architecture: process.arch, productionVerifier: true }
    }
    report.cases.push({ name: 'explicit-retry-verifies-complete-candidate-and-defers-installation', passed: true,
      filename, ...downloaded })
    for (const entry of fixtures) assert.equal(entry.installerCalls(), 0)
    assert.deepEqual(failures, [])
    report.success = true
  } catch (error) {
    report.failure = { name: error.name, message: error.message }
    throw error
  } finally {
    for (const entry of fixtures) entry.coordinator.dispose()
    const closed = new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()))
    server.closeAllConnections()
    await closed
    await Promise.all(streams)
    netSession.setCertificateVerifyProc(null)
    await persist()
  }
  console.log('MUSE_CANDIDATE_UPDATE_ACCEPTANCE', JSON.stringify(report))
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
