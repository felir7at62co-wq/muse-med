/** Deterministic mock stdio verifies the owned SSH protocol; no ssh executable is run. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Config, validateConfig, localHelperEnvironment } from '../src/config.ts'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { JsonlRequestPort } from '../src/jsonl.ts'
import { ACTIONS } from '../src/port.ts'
import { registerLvpaopao } from '../src/index.ts'

const config = { sshExecutable: 'ssh', sshHostAlias: 'lvpaopao-test', remotePython: 'C:\\test\\python.exe',
  remoteHelper: 'C:\\test\\helper.py', helperSha256: 'a'.repeat(64), cwd: process.cwd(), connectTimeoutMs: 1000,
  requestTimeoutMs: 1000, downloadRequestTimeoutMs: 1000, cancelTimeoutMs: 100, shutdownTimeoutMs: 100, maxFrameBytes: 1024, maxPending: 8 }
function fixture(onRequest = () => undefined, options = {}) {
  const runtimeConfig = options.config ?? config
  const stdin = new PassThrough(), stdout = new PassThrough(), sent = []
  let resolveDone; let spec; let launches = 0; let terminated = 0
  const done = new Promise(resolve => { resolveDone = resolve })
  let buffer = ''
  const reply = frame => stdout.write(JSON.stringify(frame) + '\n')
  const finish = () => { stdout.end(); resolveDone({ exitCode: options.exitCode ?? 0, signal: null }) }
  stdin.on('data', chunk => {
    buffer += chunk.toString()
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); sent.push(frame)
      if (frame.type === 'request' && frame.method === 'hello') {
        reply({ protocol: 1, type: 'event', event: 'waiting_target', details: { raw: 'private-detail-never-saved' } })
        reply({ protocol: 1, type: 'result', id: frame.id, value: { protocol_version: 1,
          helper_sha256: options.digest ?? runtimeConfig.helperSha256, expected_app_id: 'wx404dde55fb12df78', actions: options.actions ?? [...ACTIONS], ready: false } })
      } else if (frame.type === 'close') {
        reply({ protocol: 1, type: 'event', event: 'closed', details: options.closedDetails ?? {
          status: 'control-close', cleanup: { dispose: true, unload: true, detach: true, serverClosed: true },
        } }); finish()
      }
      else onRequest(frame, reply)
    }
  })
  const subprocess = { spawn(value) { launches++; spec = value; return { stdin, stdout, done,
    terminate() { terminated++; finish() }, async waitForExit(signal) {
      return await new Promise(resolve => {
        const abort = () => resolve(false); signal?.addEventListener('abort', abort, { once: true })
        done.then(() => { signal?.removeEventListener('abort', abort); resolve(true) })
      })
    }, collected: {} } } }
  const port = new JsonlRequestPort(subprocess, runtimeConfig)
  return { port, sent, reply, finish, inputError: error => stdin.emit('error', error), raw: bytes => stdout.write(bytes), get spec() { return spec }, get launches() { return launches }, get terminated() { return terminated } }
}

test('two operations share one exact SSH launcher and all business fields stay in JSON stdin', async () => {
  const f = fixture((frame, reply) => reply({ protocol: 1, type: 'result', id: frame.id, value: { operation: frame.method } }))
  try {
    assert.deepEqual(await f.port.request('search', { query: "title'; throw 'evil'" }, new AbortController().signal), { operation: 'search' })
    await f.port.request('status', {}, new AbortController().signal)
    assert.equal(f.launches, 1); assert.equal(f.port.connectionEvent, 'waiting_target')
    assert.equal(JSON.stringify(f.spec.argv).includes('evil'), false)
    assert.ok(f.spec.argv.includes('StrictHostKeyChecking=yes'))
    assert.equal(f.sent.find(row => row.method === 'search').params.query, "title'; throw 'evil'")
  } finally { await f.port.dispose() }
})

test('digest mismatch rejects before business request and reaches owned process exit', async () => {
  const f = fixture(undefined, { digest: 'b'.repeat(64) })
  await assert.rejects(f.port.request('search', { query: '老手' }, new AbortController().signal), /handshake-mismatch/)
  assert.equal(f.sent.some(row => row.method === 'search'), false)
})

test('cancellation waits for an explicit original-request settlement', async () => {
  let cancelFrame; let replyFunction
  const requestSeen = Promise.withResolvers()
  const f = fixture((frame, reply) => {
    if (frame.type === 'request') requestSeen.resolve()
    if (frame.type === 'cancel') { cancelFrame = frame; replyFunction = reply }
  })
  try {
    const controller = new AbortController(); let settled = false
    const work = f.port.request('search', { query: '老手' }, controller.signal).finally(() => { settled = true })
    await requestSeen.promise; controller.abort(); await Promise.resolve()
    assert.ok(cancelFrame); assert.equal(settled, false)
    replyFunction({ protocol: 1, type: 'error', id: cancelFrame.id, error: { code: 'cancelled', message: 'private-message' } })
    await assert.rejects(work, /cancelled/)
  } finally { await f.port.dispose() }
})

test('unknown response identity fails closed without returning its private body', async () => {
  const f = fixture((_frame, reply) => reply({ protocol: 1, type: 'result', id: 'not-the-request', value: 'private-secret' }))
  await assert.rejects(f.port.request('status', {}, new AbortController().signal), error => {
    assert.equal(error.message.includes('private'), false); return true
  })
})

test('missing cancellation acknowledgement closes the owned connection and never starts another request', async () => {
  const seen = Promise.withResolvers()
  const f = fixture(frame => { if (frame.type === 'request') seen.resolve() })
  const controller = new AbortController(); const work = f.port.request('search', { query: '老手' }, controller.signal)
  await seen.promise; controller.abort(); await assert.rejects(work, /cancel-unconfirmed/)
  assert.equal(f.sent.filter(row => row.method === 'search').length, 1)
  assert.ok(f.sent.some(row => row.type === 'close')); await f.port.dispose()
})

test('worker cleanup errors are never relabelled as a successful cancellation acknowledgement', async () => {
  const seen = Promise.withResolvers()
  const f = fixture((frame, reply) => {
    if (frame.type === 'request') seen.resolve()
    if (frame.type === 'cancel') reply({ protocol: 1, type: 'error', id: frame.id, error: { code: 'transfer-failed', message: 'private-error' } })
  })
  const controller = new AbortController(); const work = f.port.request('search', { query: '老手' }, controller.signal)
  await seen.promise; controller.abort(); await assert.rejects(work, /cancel-unconfirmed/)
  assert.ok(f.sent.some(row => row.type === 'close'))
})

test('oversized or malformed JSON is rejected and explicit dispose is idempotent', async () => {
  for (const invalid of ['not json\n', 'x'.repeat(1025)]) {
    const f = fixture((_frame, _reply) => { f.reply({ protocol: 1, type: 'event', event: 'ready', details: {} }); f.raw(Buffer.from(invalid)) })
    await assert.rejects(f.port.request('status', {}, new AbortController().signal))
  }
  const f = fixture((frame, reply) => reply({ protocol: 1, type: 'result', id: frame.id, value: {} }))
  await f.port.request('status', {}, new AbortController().signal)
  await Promise.all([f.port.dispose(), f.port.dispose()]); assert.equal(f.sent.filter(row => row.type === 'close').length, 1)
})

test('closed events cannot claim cleanup when a flag is false, absent, or the process failed', async () => {
  for (const options of [
    { closedDetails: {} },
    { closedDetails: { cleanup: { dispose: true, unload: true, detach: true, serverClosed: true } } },
    { closedDetails: { status: 'helper-failed', cleanup: { dispose: true, unload: true, detach: true, serverClosed: true } } },
    ...['dispose', 'unload', 'detach', 'serverClosed'].map(key => ({ closedDetails: { status: 'control-close',
      cleanup: { dispose: true, unload: true, detach: true, serverClosed: true, [key]: false } } })),
    { exitCode: 1 },
    ...['hook-disposed', 'hook-stopped', 'peer-ended'].flatMap(status => [
      { closedDetails: { status, cleanup: { dispose: true, unload: true, detach: true } } },
      { closedDetails: { status, cleanup: { dispose: true, unload: true, detach: true, serverClosed: false } } },
      { exitCode: 1, closedDetails: { status, cleanup: { dispose: true, unload: true, detach: true, serverClosed: true } } },
    ]),
  ]) {
    const f = fixture((frame, reply) => reply({ protocol: 1, type: 'result', id: frame.id, value: {} }), options)
    await f.port.request('status', {}, new AbortController().signal)
    await assert.rejects(f.port.dispose(), /remote-cleanup-unconfirmed|remote-exit-failed/)
  }
})

test('hook disposal and peer EOF confirm cleanup only with complete flags and a successful exit', async () => {
  for (const status of ['hook-disposed', 'hook-stopped', 'peer-ended']) {
    const f = fixture((frame, reply) => reply({ protocol: 1, type: 'result', id: frame.id, value: {} }), {
      closedDetails: { status, cleanup: { dispose: true, unload: true, detach: true, serverClosed: true } },
    })
    await f.port.request('status', {}, new AbortController().signal)
    await f.port.dispose()
    assert.equal(f.port.connectionEvent, 'closed')
    assert.equal(f.terminated, 0)
  }
})

test('real ToolRuntime preserves only registered safe download errors across persistent JSONL without retrying', async () => {
  const codes = ['transfer-failed', 'output-already-exists', 'download-cancelled', 'media-process-cleanup-failed']
  const privateText = 'https://synthetic.invalid/private?capability=never-visible'
  let nextCode
  const f = fixture((frame, reply) => reply({ protocol: 1, type: 'error', id: frame.id,
    error: { code: nextCode, message: privateText, stack: privateText, details: { rawUrl: privateText } } }))
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    const adapter = ctx.plugin({ name: 'lvpaopao-safe-download-error-test', inject: ['tools'], apply(child) {
      registerLvpaopao(child, f.port, { ...config, maxQueryChars: 80, maxEpisodeCount: 20, maxResultItems: 50 })
    } })
    await adapter.await()
    assert.ok(ctx.tools.get('lvpaopao'))
    for (const [index, code] of [...codes, 'unregistered-error', privateText].entries()) {
      nextCode = code
      const before = f.sent.filter(frame => frame.method === 'download_first_episode').length
      const executed = await ctx.tools.execute({ callId: `download-error-${index}`, name: 'lvpaopao',
        arguments: { action: 'download_first_episode', srcAppId: 'wx6522458df7ed3af2', dramaId: '121225' }, signal: new AbortController().signal })
      const value = JSON.parse(executed.content[0].text)
      const expected = codes.includes(code) ? code : 'remote-error'
      assert.equal(executed.isError, false)
      assert.equal(value.ok, false)
      assert.equal(value.status, expected)
      assert.equal(value.error.code, expected)
      assert.deepEqual(value.data, {})
      assert.match(value.error.message, /original operation before retrying/)
      assert.equal(JSON.stringify(executed).includes(privateText), false)
      assert.equal(JSON.stringify(executed).includes('rawUrl'), false)
      assert.equal(f.sent.filter(frame => frame.method === 'download_first_episode').length, before + 1)
    }
    assert.equal(f.launches, 1)
  } finally {
    await ctx.fiber.dispose()
    await f.port.dispose()
  }
})


async function localConfig(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lvpaopao-local-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const localHelper = join(root, 'run-persistent-host.py'), source = '# synthetic helper; not executed\n'
  await writeFile(localHelper, source)
  return validateConfig(Config({ transport: 'local', localPython: process.execPath, localHelper,
    helperSha256: createHash('sha256').update(source).digest('hex'), cwd: root,
    connectTimeoutMs: 1000, requestTimeoutMs: 1000, downloadRequestTimeoutMs: 1000,
    cancelTimeoutMs: 100, shutdownTimeoutMs: 100, maxFrameBytes: 1024, maxPending: 8 }))
}

test('local transport verifies the actual helper and uses a fixed Python argv without SSH or model strings', async t => {
  const local = await localConfig(t)
  const f = fixture((frame, reply) => reply({ protocol: 1, type: 'result', id: frame.id, value: { operation: frame.method } }), { config: local })
  try {
    await f.port.request('search', { query: 'title; private-argument' }, new AbortController().signal)
    assert.deepEqual(f.spec.argv, [local.localPython, '-u', local.localHelper, '--rpc-stdio'])
    assert.equal(f.spec.env.PYTHONUTF8, '1'); assert.equal(f.spec.env.PYTHONIOENCODING, 'utf-8')
    assert.equal(JSON.stringify(f.spec.argv).includes('private-argument'), false)
    assert.equal(f.launches, 1)
  } finally { await f.port.dispose() }
})

test('local helper digest mismatch, missing files and symlinks reject before any process starts', async t => {
  const local = await localConfig(t)
  const link = join(local.cwd, 'helper-link.py'); await symlink(local.localHelper, link)
  for (const config of [{ ...local, helperSha256: 'b'.repeat(64) }, { ...local, localHelper: join(local.cwd, 'missing.py') }, { ...local, localHelper: link }]) {
    const f = fixture(undefined, { config })
    await assert.rejects(f.port.request('status', {}, new AbortController().signal), { code: 'helper-identity-mismatch' })
    await f.port.dispose(); assert.equal(f.launches, 0)
  }
})

test('local cancellation waits for the original settlement and closes its owned process once', async t => {
  const local = await localConfig(t), entered = Promise.withResolvers()
  const f = fixture((frame, reply) => {
    if (frame.type === 'request') entered.resolve()
    if (frame.type === 'cancel') reply({ protocol: 1, type: 'error', id: frame.id, error: { code: 'cancelled' } })
  }, { config: local })
  const controller = new AbortController(), work = f.port.request('download_episode', { episodeNo: 2 }, controller.signal)
  await entered.promise; controller.abort(); await assert.rejects(work, { code: 'cancelled' })
  await f.port.dispose(); assert.equal(f.sent.filter(frame => frame.type === 'close').length, 1); assert.equal(f.launches, 1)
})

test('local configuration uses current-platform absolute paths while legacy configurations resolve explicitly to SSH', async t => {
  const local = await localConfig(t)
  for (const fields of [{ localPython: 'python' }, { localHelper: 'helper.py' }, { localHelper: '/absolute\nhelper.py' }]) {
    assert.throws(() => validateConfig({ ...local, ...fields }), /local absolute paths required/)
  }
  const legacy = validateConfig(Config({ ...config }))
  assert.equal(legacy.transport, 'ssh'); assert.equal(legacy.localPython, ''); assert.equal(legacy.localHelper, '')
})

test('arbitrary episode download and first episode download both use the long transfer deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const action of ['download_first_episode', 'download_episode']) {
    const entered = Promise.withResolvers()
    const f = fixture((frame, reply) => {
      if (frame.type === 'request') entered.resolve({ frame, reply })
    }, { config: { ...config, requestTimeoutMs: 1000, downloadRequestTimeoutMs: 600000 } })
    try {
      const work = f.port.request(action, { episodeNo: 2 }, new AbortController().signal)
      const { frame, reply } = await entered.promise
      t.mock.timers.tick(31000)
      await Promise.resolve()
      assert.equal(f.sent.some(value => value.type === 'cancel'), false)
      reply({ protocol: 1, type: 'result', id: frame.id, value: { operation: action, status: 'download-returned' } })
      assert.deepEqual(await work, { operation: action, status: 'download-returned' })
    } finally { await f.port.dispose() }
  }
})


test('local helpers explicitly retain only trusted media paths and UTF-8 protocol settings', () => {
  assert.deepEqual(localHelperEnvironment({ DSH_FFMPEG_PATH: '/trusted/ffmpeg', DSH_FFPROBE_PATH: '/trusted/ffprobe',
    DSH_PRIVATE_TOKEN: 'must-not-forward', PYTHONIOENCODING: 'gbk', PYTHONUTF8: '0' }), {
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DSH_FFMPEG_PATH: '/trusted/ffmpeg', DSH_FFPROBE_PATH: '/trusted/ffprobe',
  })
})

test('the pinned five-action SSH helper retains inspection and first-episode operations without advertising series support', async () => {
  const f = fixture((frame, reply) => reply({ protocol: 1, type: 'result', id: frame.id, value: { operation: frame.method } }), { actions: ACTIONS.slice(0, 5) })
  try {
    assert.deepEqual(await f.port.request('search', { query: 'legacy' }, new AbortController().signal), { operation: 'search' })
    await assert.rejects(f.port.request('download_episode', {}, new AbortController().signal), /capability-not-ready/)
    assert.deepEqual(await f.port.request('download_first_episode', {}, new AbortController().signal), { operation: 'download_first_episode' })
    assert.equal(f.launches, 1); assert.equal(f.sent.some(frame => frame.method === 'download_episode'), false)
  } finally { await f.port.dispose() }
})

test('capability negotiation rejects missing legacy operations, duplicate entries and unknown native actions', async () => {
  for (const actions of [ACTIONS.slice(0, 4), [...ACTIONS.slice(0, 4), 'unknown-operation'], [...ACTIONS.slice(0, 4), 'status']]) {
    const f = fixture(undefined, { actions })
    await assert.rejects(f.port.request('status', {}, new AbortController().signal), /handshake-mismatch/)
    await assert.rejects(f.port.dispose(), /remote-cleanup-unconfirmed/)
    assert.equal(f.sent.some(frame => frame.method === 'status'), false)
  }
})


test('a broken helper input pipe becomes a connection failure without an unhandled stream error', async () => {
  const f=fixture((frame,reply)=>reply({protocol:1,type:'result',id:frame.id,value:{status:'ready'}}))
  await f.port.request('status',{},new AbortController().signal)
  assert.doesNotThrow(()=>f.inputError(Object.assign(new Error('private native pipe details'),{code:'EPIPE'})))
  await assert.rejects(f.port.request('status',{},new AbortController().signal),/connection-lost/)
  await assert.rejects(f.port.dispose(),/remote-cleanup-unconfirmed/)
})
