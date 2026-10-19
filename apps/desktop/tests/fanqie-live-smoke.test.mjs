/** Offline installed-download receipts and lifecycle checks; no test contacts Fanqie. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { checkFanqieLive, fanqieLiveBook } from './fixtures/fanqie-live-smoke.mjs'

const selected = { bookId: '1000000000000000001', title: '纸灯回声（测试虚构）', author: '虚构作者' }
const environment = { MUSE_FANQIE_LIVE_REQUIRED: '1', MUSE_FANQIE_LIVE_BOOK_ID: selected.bookId,
  MUSE_FANQIE_LIVE_TITLE: selected.title, MUSE_FANQIE_LIVE_AUTHOR: selected.author,
  MUSE_HONGGUO_PYTHON_PATH: join(import.meta.dirname, 'bundled', 'python') }
const sha256 = content => createHash('sha256').update(content).digest('hex')
const chapters = [
  { itemId: '2000000000000000001', title: '第1章 留灯', text: '第1章 留灯\n林岚留下一盏纸灯。' },
  { itemId: '2000000000000000002', title: '第2章 回声', text: '第2章 回声\n许川认出灯底的字。' },
]

function fixture(change = () => {}, changeCatalog = () => {}) {
  const events = []
  let workspace, paths
  return {
    events, workspace: () => workspace, paths: () => paths,
    async mount(_root, actualPaths) {
      events.push('mount')
      paths = actualPaths
      return {
        client: {
          config: { networkMode: 'direct' },
          async call(operation, args, directory, signal) {
            assert.deepEqual(args, { bookIds: [selected.bookId] })
            assert.equal(signal.aborted, false)
            workspace = directory
            events.push(operation)
            if (operation === 'info') {
              const result = { ok: true, complete: false, items: [{ ...selected, chapterCount: chapters.length,
                chapters: chapters.map(({ itemId, title }) => ({ itemId, title })) }] }
              await changeCatalog(result, directory)
              return result
            }
            assert.equal(operation, 'download')
            const outputDir = join(directory, 'downloads', 'fanqie', 'fanqie-fixture')
            await mkdir(outputDir, { recursive: true })
            const file = join(outputDir, `${selected.bookId}.txt`)
            const text = `${selected.title}\n\n${chapters.map(chapter => chapter.text).join('\n\n')}\n\n`
            await writeFile(file, text, { flag: 'wx' })
            const result = { ok: true, complete: true, outputDir, items: [{ ...selected, complete: true,
              scope: 'current-published-directory', chapterCount: chapters.length, downloadedChapters: chapters.length,
              file, bytes: Buffer.byteLength(text), sha256: sha256(text),
              chapters: chapters.map(({ itemId, title, text: body }) => ({ itemId, title,
                characters: [...body].length, sha256: sha256(body) })) }] }
            await change(result, directory)
            return result
          },
          async dispose() { events.push('client-exit') },
        },
        async disposeContext() { events.push('context-exit') },
      }
    },
  }
}

const run = (f, env = environment) => checkFanqieLive('/installed', import.meta.dirname, env, f.mount)

test('disabled installed smokes allocate no runtime and make no request', async () => {
  assert.equal(fanqieLiveBook({}), null)
  assert.equal(fanqieLiveBook({ MUSE_FANQIE_LIVE_REQUIRED: '0' }), null)
  let mounted = false
  assert.deepEqual(await checkFanqieLive('/installed', '/runtime', {}, async () => { mounted = true }), { required: false })
  assert.equal(mounted, false)
})

test('invalid opt-in identity or non-bundled Python fails before mounting', async () => {
  for (const values of [{ MUSE_FANQIE_LIVE_REQUIRED: 'yes' }, { MUSE_FANQIE_LIVE_BOOK_ID: '1' },
    { MUSE_FANQIE_LIVE_BOOK_ID: Number(selected.bookId) }, { MUSE_FANQIE_LIVE_TITLE: '' },
    { MUSE_FANQIE_LIVE_TITLE: ' wrong ' }, { MUSE_FANQIE_LIVE_AUTHOR: 'author\n' },
    { MUSE_FANQIE_LIVE_AUTHOR: undefined }, { MUSE_HONGGUO_PYTHON_PATH: '' },
    { MUSE_HONGGUO_PYTHON_PATH: process.execPath }]) {
    const f = fixture()
    await assert.rejects(run(f, { ...environment, ...values }))
    assert.deepEqual(f.events, [])
  }
})

test('verifies UTF-8 identity, every chapter receipt and independent TXT hash before joined cleanup', async () => {
  const f = fixture()
  const result = await run(f)
  assert.deepEqual(fanqieLiveBook(environment), selected)
  assert.equal(result.required, true)
  assert.equal(result.complete, true)
  assert.equal(result.networkMode, 'direct')
  assert.equal(result.title, selected.title)
  assert.equal(result.author, selected.author)
  assert.equal(result.chapters, 2)
  assert.equal(result.utf8, true)
  assert.equal(result.independentlyHashed, true)
  assert.equal(result.chapterReceiptsVerified, true)
  assert.equal(result.cleanup, true)
  assert.match(result.sha256, /^[a-f0-9]{64}$/u)
  assert.ok(result.bytes > 0)
  assert.deepEqual(f.paths(), { python: environment.MUSE_HONGGUO_PYTHON_PATH })
  assert.deepEqual(f.events, ['mount', 'info', 'download', 'client-exit', 'context-exit'])
  assert.equal(existsSync(f.workspace()), false)
  assert.equal(JSON.stringify(result).includes(f.workspace()), false)
})

for (const [name, change] of [
  ['different book', result => { result.items[0].bookId = '1000000000000000009' }],
  ['different title', result => { result.items[0].title = '另一本书' }],
  ['different author', result => { result.items[0].author = '另一位作者' }],
  ['incomplete catalog', result => { result.items[0].chapterCount++ }],
  ['duplicate catalog chapter', result => { result.items[0].chapters[1].itemId = result.items[0].chapters[0].itemId }],
]) {
  test(`rejects ${name} before downloading or accepting a book`, async () => {
    const f = fixture(() => {}, change)
    await assert.rejects(run(f), /^Error: Fanqie live installed acceptance failed \(stage=catalog\)$/u)
    assert.deepEqual(f.events, ['mount', 'info', 'client-exit', 'context-exit'])
    assert.equal(existsSync(f.workspace()), false)
  })
}

for (const [name, change] of [
  ['partial download', result => { result.complete = false }],
  ['missing chapter', result => { result.items[0].downloadedChapters-- }],
  ['chapter order changed', result => { result.items[0].chapters.reverse() }],
  ['wrong chapter hash', result => { result.items[0].chapters[0].sha256 = '0'.repeat(64) }],
  ['wrong chapter length', result => { result.items[0].chapters[0].characters++ }],
  ['wrong file hash', result => { result.items[0].sha256 = '0'.repeat(64) }],
  ['wrong file size', result => { result.items[0].bytes++ }],
  ['outside workspace', result => { result.items[0].file = import.meta.filename }],
  ['leftover partial file', async (_result, directory) => { await writeFile(join(directory, 'unfinished.part'), 'partial') }],
  ['empty staging directory', async result => { await mkdir(join(result.outputDir, '.fanqie-abandoned')) }],
  ['empty partial directory', async (_result, directory) => { await mkdir(join(directory, 'unfinished.part')) }],
  ['empty TXT', async result => {
    const item = result.items[0]
    await writeFile(item.file, '')
    item.bytes = 0
    item.sha256 = sha256('')
  }],
  ['invalid UTF-8 TXT', async result => {
    const item = result.items[0], bytes = Buffer.from([0xc3, 0x28])
    await writeFile(item.file, bytes)
    item.bytes = bytes.length
    item.sha256 = sha256(bytes)
  }],
]) {
  test(`rejects ${name} and removes temporary content after disposal`, async () => {
    const f = fixture(change)
    await assert.rejects(run(f), /^Error: Fanqie live installed acceptance failed \(stage=(download|files)\)$/u)
    assert.deepEqual(f.events.slice(-2), ['client-exit', 'context-exit'])
    assert.equal(existsSync(f.workspace()), false)
  })
}

test('does not disclose source exception text and still joins both disposers', async () => {
  const f = fixture(() => { throw new Error('private-device-and-signed-url') })
  await assert.rejects(run(f), /^Error: Fanqie live installed acceptance failed \(stage=download\)$/u)
  assert.deepEqual(f.events.slice(-2), ['client-exit', 'context-exit'])
  assert.equal(existsSync(f.workspace()), false)
})

test('preserves known registration TLS facts without source text or private fields', async () => {
  const f = fixture(() => {}, result => {
    Object.assign(result, { ok: false, complete: false, code: 'URLError', sourceStage: 'registration',
      host: 'log.snssdk.com', networkMode: 'direct', privateResponse: 'private-device-response',
      message: 'private-request-url', error: { type: 'URLError', reasonType: 'SSLEOFError', errno: 8,
        message: 'private-exception-text', privateToken: 'private-token' } })
  })
  const error = await run(f).then(() => assert.fail('A failed catalog cannot pass acceptance'), failure => failure)
  assert.equal(error.message, 'Fanqie live installed acceptance failed (stage=catalog; source='
    + '{"code":"URLError","sourceStage":"registration","host":"log.snssdk.com","networkMode":"direct",'
    + '"error":{"type":"URLError","reasonType":"SSLEOFError","errno":8}})')
  assert.doesNotMatch(error.message, /private/u)
  assert.deepEqual(f.events, ['mount', 'info', 'client-exit', 'context-exit'])
  assert.equal(existsSync(f.workspace()), false)
})

test('drops unknown classification fields and invalid numeric diagnostics', async () => {
  const f = fixture(() => {}, result => {
    Object.assign(result, { ok: false, complete: false, code: 'private-code', sourceStage: 'private-stage',
      host: 'private.example', networkMode: 'private-mode', error: { type: 'private-type',
        reasonType: 'private-reason', httpStatus: 999, errno: 'private-number', message: 'private-message' } })
  })
  await assert.rejects(run(f), /^Error: Fanqie live installed acceptance failed \(stage=catalog\)$/u)
  assert.equal(existsSync(f.workspace()), false)
})

test('preserves an HTTP failure classification during download after joined cleanup', async () => {
  const f = fixture(result => {
    Object.assign(result, { ok: false, complete: false, code: 'HTTPError', sourceStage: 'chapter-download',
      host: 'api5-normal.fqnovel.com', networkMode: 'direct',
      error: { type: 'HTTPError', reasonType: 'HTTPError', httpStatus: 503, errno: -2, message: 'private-response' } })
  })
  const error = await run(f).then(() => assert.fail('A failed download cannot pass acceptance'), failure => failure)
  assert.match(error.message, /stage=download; source=/u)
  assert.match(error.message, /"sourceStage":"chapter-download"/u)
  assert.match(error.message, /"httpStatus":503,"errno":-2/u)
  assert.doesNotMatch(error.message, /private/u)
  assert.deepEqual(f.events.slice(-2), ['client-exit', 'context-exit'])
  assert.equal(existsSync(f.workspace()), false)
})

test('rejects a changed installed network default before any platform request', async () => {
  const f = fixture()
  await assert.rejects(checkFanqieLive('/installed', import.meta.dirname, environment, async (...args) => {
    const runtime = await f.mount(...args)
    runtime.client.config.networkMode = 'system'
    return runtime
  }), /^Error: Fanqie live installed acceptance failed \(stage=mount\)$/u)
  assert.deepEqual(f.events, ['mount', 'client-exit', 'context-exit'])
})

for (const failedDisposer of ['client', 'context']) {
  test(`a ${failedDisposer} disposal error refuses success but still removes private TXT`, async () => {
    const f = fixture()
    await assert.rejects(checkFanqieLive('/installed', import.meta.dirname, environment, async (...args) => {
      const runtime = await f.mount(...args)
      if (failedDisposer === 'client') runtime.client.dispose = async () => {
        f.events.push('client-exit')
        throw new Error('private-client-disposal')
      }
      else runtime.disposeContext = async () => {
        f.events.push('context-exit')
        throw new Error('private-context-disposal')
      }
      return runtime
    }), /^Error: Fanqie live installed acceptance failed \(stage=cleanup\)$/u)
    assert.deepEqual(f.events.slice(-2), ['client-exit', 'context-exit'])
    assert.equal(existsSync(f.workspace()), false)
  })
}

test('waits for both disposers before removing TXT and returning success', async () => {
  const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
  }
  const clientEntered = deferred(), clientExit = deferred(), contextEntered = deferred(), contextExit = deferred()
  const f = fixture()
  let completed = false
  const acceptance = checkFanqieLive('/installed', import.meta.dirname, environment, async (...args) => {
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

test('simultaneous installed checks own distinct private workspaces', async () => {
  const first = fixture(), second = fixture()
  const results = await Promise.all([run(first), run(second)])
  assert.notEqual(first.workspace(), second.workspace())
  assert.ok(results.every(result => result.cleanup === true))
  assert.equal(existsSync(first.workspace()), false)
  assert.equal(existsSync(second.workspace()), false)
})
