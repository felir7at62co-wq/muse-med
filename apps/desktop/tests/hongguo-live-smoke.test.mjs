/** Synthetic acceptance failures exercise receipts and cleanup; only opt-in installed runs contact the platform. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { checkHongguoLive, hongguoLiveSeries } from './fixtures/hongguo-live-smoke.mjs'

const ids = ['7687998333729639449', '7691176265872591896']
const environment = { MUSE_HONGGUO_LIVE_REQUIRED: '1', MUSE_HONGGUO_LIVE_IDS: ids.join(','),
  MUSE_HONGGUO_BOOTSTRAP_DEVICES: '1', MUSE_HONGGUO_LEGACY_APP_DIR: import.meta.dirname,
  MUSE_HONGGUO_JAVA_PATH: process.execPath, MUSE_HONGGUO_PYTHON_PATH: process.execPath }

function fixture(change = () => {}) {
  const events = []
  let workspace, paths
  return {
    events, workspace: () => workspace, paths: () => paths,
    async mount(_root, actualPaths, platformRequests) {
      paths = actualPaths
      assert.equal(platformRequests, true)
      events.push('mount')
      return {
        client: {
          async download(options, signal, directory) {
            assert.deepEqual(options, { seriesIds: ids })
            assert.equal(signal.aborted, false)
            workspace = directory
            const result = { ok: true, complete: true, fullDecodeChecked: true, path: directory,
              items: [], validatedBytes: 0 }
            for (const seriesId of ids) {
              const target = join(directory, seriesId)
              await mkdir(target)
              const content = Buffer.from(`synthetic-${seriesId}`)
              const path = join(target, '0001.mp4')
              await writeFile(path, content)
              result.validatedBytes += content.length
              result.items.push({ seriesId, complete: true, episodeCount: 1, downloadedEpisodeCount: 1,
                episodes: [{ index: 1, path, bytes: content.length, fullDecodeChecked: true,
                  validationLevel: 'ffprobe-full-decode-sha256', sha256: createHash('sha256').update(content).digest('hex') }] })
            }
            await change(result, directory)
            await writeFile(join(directory, 'download-manifest.json'), JSON.stringify(result))
            events.push('download')
            return result
          },
          async dispose() { events.push('client-exit') },
        },
        async disposeContext() { events.push('context-exit') },
      }
    },
  }
}

test('ordinary native smokes cannot initiate platform requests', async () => {
  assert.equal(hongguoLiveSeries({}), null)
  let mounted = false
  assert.deepEqual(await checkHongguoLive('/root', '/runtime', {}, async () => { mounted = true }), { required: false })
  assert.equal(mounted, false)
})

test('invalid opt-in settings fail before acquiring native resources', async () => {
  for (const values of [{ MUSE_HONGGUO_LIVE_REQUIRED: 'yes' }, { MUSE_HONGGUO_LIVE_IDS: '' },
    { MUSE_HONGGUO_LIVE_IDS: ids[0] }, { MUSE_HONGGUO_LIVE_IDS: `${ids[0]},${ids[0]}` },
    { MUSE_HONGGUO_LIVE_IDS: `${ids[0]},not-a-series` }, { MUSE_HONGGUO_JAVA_PATH: '' }]) {
    let mounted = false
    await assert.rejects(checkHongguoLive('/root', '/runtime', { ...environment, ...values }, async () => { mounted = true }))
    assert.equal(mounted, false)
  }
})

test('independent hashes and complete coverage precede joined private workspace removal', async () => {
  const f = fixture()
  const result = await checkHongguoLive('/installed', import.meta.dirname, environment, f.mount)
  assert.equal(result.required, true)
  assert.equal(result.episodes, 2)
  assert.equal(result.independentlyHashed, true)
  assert.equal(result.cleanup, true)
  assert.deepEqual(result.series.map(item => item.seriesId), ids)
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/u)
  assert.ok(f.paths().ffprobe.endsWith(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'))
  assert.deepEqual(f.events, ['mount', 'download', 'client-exit', 'context-exit'])
  assert.equal(existsSync(f.workspace()), false)
  assert.equal(JSON.stringify(result).includes(f.workspace()), false)
})

for (const [name, change] of [
  ['partial series', result => { result.complete = false }],
  ['duplicate series', result => { result.items[1].seriesId = ids[0] }],
  ['missing episode', result => { result.items[0].episodeCount++ }],
  ['wrong episode', result => { result.items[0].episodes[0].index++ }],
  ['unchecked decode', result => { result.items[0].episodes[0].fullDecodeChecked = false }],
  ['duplicate file', result => { result.items[1].episodes[0].path = result.items[0].episodes[0].path }],
  ['size mismatch', result => { result.items[0].episodes[0].bytes++ }],
  ['hash mismatch', result => { result.items[0].episodes[0].sha256 = '0'.repeat(64) }],
  ['outside workspace', result => { result.items[0].episodes[0].path = import.meta.filename }],
  ['byte total mismatch', result => { result.validatedBytes++ }],
]) {
  test(`rejects ${name} and removes all private files after disposal`, async () => {
    const f = fixture(change)
    await assert.rejects(checkHongguoLive('/installed', import.meta.dirname, environment, f.mount),
      /^Error: Hongguo live installed acceptance failed \(stage=(download|files)\)$/u)
    assert.deepEqual(f.events.slice(-2), ['client-exit', 'context-exit'])
    assert.equal(existsSync(f.workspace()), false)
  })
}

test('a source failure cannot disclose response contents and still joins both disposers', async () => {
  const f = fixture(() => { throw new Error('private-device-and-signed-url') })
  await assert.rejects(checkHongguoLive('/installed', import.meta.dirname, environment, f.mount),
    /^Error: Hongguo live installed acceptance failed \(stage=download\)$/u)
  assert.deepEqual(f.events, ['mount', 'client-exit', 'context-exit'])
  assert.equal(existsSync(f.workspace()), false)
})

test('acceptance waits for both owned disposers before deleting media or returning success', { timeout: 30_000 }, async () => {
  const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
  }
  const clientEntered = deferred(), clientExit = deferred(), contextEntered = deferred(), contextExit = deferred()
  const f = fixture()
  let completed = false
  const acceptance = checkHongguoLive('/installed', import.meta.dirname, environment, async (...args) => {
    const runtime = await f.mount(...args)
    const disposeClient = runtime.client.dispose, disposeContext = runtime.disposeContext
    runtime.client.dispose = async () => { clientEntered.resolve(); await clientExit.promise; await disposeClient() }
    runtime.disposeContext = async () => { contextEntered.resolve(); await contextExit.promise; await disposeContext() }
    return runtime
  }).then(result => { completed = true; return result })
  try {
    await clientEntered.promise
    assert.equal(completed, false)
    assert.equal(existsSync(f.workspace()), true)
    clientExit.resolve()
    await contextEntered.promise
    assert.equal(completed, false)
    assert.equal(existsSync(f.workspace()), true)
    contextExit.resolve()
    assert.equal((await acceptance).cleanup, true)
    assert.equal(existsSync(f.workspace()), false)
  } finally {
    clientExit.resolve()
    contextExit.resolve()
    await acceptance
  }
})
