/** Host-private local setup with synthetic managed process IO; no Python or target runtime is executed. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import LvpaopaoBridge from '../src/bridge.ts'
import { ACTIONS } from '../src/port.ts'

const signal = () => new AbortController().signal
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lvpaopao-setup-'))), oldHome = process.env.MUSE_HOME
  process.env.MUSE_HOME = root
  const resources = join(root, 'installed-native'), runtime = join(root, 'lvpaopao', 'runtime')
  const cwd = join(runtime, 'passive-probe', 'next-stage'), helper = join(cwd, 'run-persistent-host.py')
  await mkdir(resources, { recursive: true }); await mkdir(cwd, { recursive: true })
  await writeFile(join(resources, 'boot.py'), '# synthetic owned bootstrap\n')
  const helperSource = '# synthetic copied helper\n'; await writeFile(helper, helperSource)
  const configuration = { transport: 'local', localPython: process.execPath, localHelper: helper, cwd,
    helperSha256: createHash('sha256').update(helperSource).digest('hex'), downloadEnabled: true,
    connectTimeoutMs: 1000, requestTimeoutMs: 1000, downloadRequestTimeoutMs: 1000, cancelTimeoutMs: 100, shutdownTimeoutMs: 100 }
  const ctx = new Context(), spawns = [], setups = [], rpcs = []
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally {
      if (oldHome === undefined) delete process.env.MUSE_HOME; else process.env.MUSE_HOME = oldHome
      await rm(root, { recursive: true, force: true })
    }
  })
  await ctx.plugin(AgentRegistry)
  ctx.provide('subprocess', { spawn(spec) {
    assert.equal(ctx.agents.currentInitiator(), undefined)
    spawns.push(spec)
    const settled = Promise.withResolvers(), stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    const control = { spec, terminated: 0, waits: 0, text: '', exited: false,
      finish(text = JSON.stringify(configuration), exitCode = 0) { control.text = text; control.exited = true; settled.resolve({ exitCode, signal: null }) },
      stderr(text) { stderr.write(text) },
      closed() { stdout.write(JSON.stringify({ protocol: 1, type: 'event', event: 'closed', details: {
        status: 'control-close', cleanup: { dispose: true, unload: true, detach: true, serverClosed: true } } }) + '\n'); control.finish('') },
    }
    const handle = { stdin, stdout, stderr, done: settled.promise,
      collected: { stdout: { readFrom() { return { text: control.text, nextOffset: Buffer.byteLength(control.text), lossy: options.lossy === true } } } },
      terminate() { control.terminated++; if (options.deferTerminate) options.deferTerminate(control); else control.finish('', 1) },
      async waitForExit(waitSignal) {
        control.waits++
        if (options.cleanup === false) return false
        if (control.exited) return true
        return await new Promise(resolve => {
          const abort = () => resolve(false)
          waitSignal?.addEventListener('abort', abort, { once: true })
          settled.promise.then(() => { waitSignal?.removeEventListener('abort', abort); resolve(true) })
          if (waitSignal?.aborted) abort()
        })
      },
    }
    if (spec.argv.includes('--prepare')) {
      setups.push(control)
      queueMicrotask(() => options.prepare ? options.prepare(control, configuration) : control.finish())
    } else {
      rpcs.push(control); let buffer = ''
      stdin.on('data', chunk => {
        buffer += chunk.toString()
        for (;;) {
          const newline = buffer.indexOf('\n'); if (newline === -1) break
          const frame = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
          if (frame.type === 'close') { control.closed(); continue }
          if (frame.type !== 'request') continue
          if (frame.method !== 'hello' && options.nativeRequest) {
            options.nativeRequest(frame, control, value => stdout.write(JSON.stringify({ protocol: 1, type: 'result', id: frame.id, value }) + '\n'),
              code => stdout.write(JSON.stringify({ protocol: 1, type: 'error', id: frame.id, error: { code } }) + '\n'))
          } else {
            const value = frame.method === 'hello' ? { protocol_version: 1, helper_sha256: options.explicit?.helperSha256 ?? configuration.helperSha256,
              expected_app_id: 'wx404dde55fb12df78', actions: [...ACTIONS], ready: true } : { operation: frame.method }
            stdout.write(JSON.stringify({ protocol: 1, type: 'result', id: frame.id, value }) + '\n')
          }
        }
      })
    }
    return handle
  } })
  const connectionFile = join(root, 'connection.json')
  if (options.explicit !== undefined) await writeFile(connectionFile, JSON.stringify(options.explicit), { mode: 0o600 })
  const fiber = ctx.plugin(LvpaopaoBridge, { connectionFile, autoSetup: true, pythonExecutable: process.execPath,
    resourcesDirectory: resources, setupTimeoutMs: 1000, setupShutdownTimeoutMs: 100, helperLifetimeMs: 3600000,
    ...options.bridge })
  await fiber.await()
  return { ctx, fiber, bridge: ctx.lvpaopaoBridge, root, runtime, resources, configuration, setups, rpcs, spawns }
}

test('missing private configuration prepares one fixed local runtime and real requests reuse its configuration', async t => {
  const f = await fixture(t)
  assert.equal(f.bridge.configuration, undefined); assert.deepEqual(f.spawns, [])
  const configured = await f.ctx.agents.withInitiator({ id: 'caller-a' }, () => f.bridge.resolveConfiguration(signal()))
  assert.equal(configured.transport, 'local'); assert.equal(Object.isFrozen(configured), true)
  assert.deepEqual(f.setups[0].spec.argv, [process.execPath, '-u', join(f.resources, 'boot.py'), '--prepare',
    '--home', f.runtime, '--resources', f.resources, '--lifetime-ms', '3600000', '--max-callbacks', '4096'])
  assert.equal(f.setups[0].spec.env.PYTHONUTF8, '1'); assert.equal(f.setups[0].spec.env.PYTHONIOENCODING, 'utf-8')
  assert.equal(f.setups[0].waits, 1); assert.equal(f.setups[0].terminated, 0)
  assert.deepEqual(await f.bridge.request('status', {}, signal()), { operation: 'status' })
  assert.deepEqual(await f.bridge.request('search', { query: 'native-argument-only' }, signal()), { operation: 'search' })
  assert.equal(f.setups.length, 1); assert.equal(f.rpcs.length, 1)
  assert.deepEqual(f.rpcs[0].spec.argv, [configured.localPython, '-u', configured.localHelper, '--rpc-stdio'])
  assert.equal(JSON.stringify(f.spawns.map(spec => spec.argv)).includes('native-argument-only'), false)
})

test('concurrent setup callers share one Host-owned preparation and a cancelled caller cannot terminate it', async t => {
  const entered = Promise.withResolvers()
  const f = await fixture(t, { prepare(control) { entered.resolve(control) } })
  const firstController = new AbortController()
  const first = assert.rejects(f.bridge.resolveConfiguration(firstController.signal), { code: 'cancelled' })
  const control = await entered.promise
  const second = f.bridge.resolveConfiguration(signal()), third = f.bridge.resolveConfiguration(signal())
  firstController.abort(); await first
  assert.equal(control.terminated, 0); assert.equal(f.setups.length, 1)
  control.finish(); const [left, right] = await Promise.all([second, third])
  assert.equal(left, right); assert.equal(left, f.bridge.configuration); assert.equal(f.setups.length, 1)
})

test('private explicit SSH configuration remains authoritative and never starts automatic setup', async t => {
  const explicit = { sshHostAlias: 'trusted-explicit-target', remotePython: 'C:\\test\\python.exe', remoteHelper: 'C:\\test\\helper.py',
    helperSha256: 'b'.repeat(64), cwd: process.cwd() }
  const f = await fixture(t, { explicit })
  const resolved = await f.bridge.resolveConfiguration(signal())
  assert.equal(resolved.transport, 'ssh'); assert.equal(resolved.sshHostAlias, explicit.sshHostAlias); assert.equal(f.setups.length, 0)
})

test('failed preparation is explicit and cached rather than silently selecting an SSH fallback or repeating setup', async t => {
  const f = await fixture(t, { prepare(control) { control.finish('private diagnostic never forwarded', 1) } })
  await assert.rejects(f.bridge.resolveConfiguration(signal()), { code: 'setup-required' })
  await assert.rejects(f.bridge.request('search', { query: 'no-replay' }, signal()), { code: 'setup-required' })
  assert.equal(f.setups.length, 1); assert.equal(f.rpcs.length, 0); assert.equal(f.setups[0].waits, 1)
})

test('fixed Mac setup failures remain cached until explicit status recovery, without business replay', async t => {
  for (const code of ['mac-isolated-wechat-required', 'mac-runtime-build-unsupported', 'mac-runtime-home-invalid']) {
    await t.test(code, async sub => {
      let attempts = 0
      const f = await fixture(sub, { prepare(control) {
        if (++attempts === 1) control.finish(JSON.stringify({ error: { code } }), 1); else control.finish()
      } })
      await assert.rejects(f.bridge.request('search', { query: 'not-submitted' }, signal()), { code })
      await assert.rejects(f.bridge.request('rankings', {}, signal()), { code })
      assert.equal(f.setups.length, 1); assert.equal(f.rpcs.length, 0)
      assert.deepEqual(await f.bridge.request('status', {}, signal()), { operation: 'status' })
      assert.equal(f.setups.length, 2); assert.equal(f.rpcs.length, 1)
    })
  }
})

test('failed bootstrap stdout cannot expose arbitrary codes, extra fields, lossy or oversized diagnostics', async t => {
  for (const options of [
    { text: JSON.stringify({ error: { code: 'private-secret' } }) },
    { text: JSON.stringify({ error: { code: 'mac-isolated-wechat-required', detail: 'private-secret' } }) },
    { text: JSON.stringify({ error: { code: 'mac-isolated-wechat-required' }, detail: 'private-secret' }) },
    { text: JSON.stringify({ error: { code: 'mac-isolated-wechat-required' } }), lossy: true },
    { text: ' '.repeat(65537) },
  ]) {
    await t.test('reject unsafe diagnostics', async sub => {
      const f = await fixture(sub, { lossy: options.lossy, prepare(control) { control.finish(options.text, 1) } })
      await assert.rejects(f.bridge.resolveConfiguration(signal()), { code: 'setup-required' })
      assert.equal(f.rpcs.length, 0)
    })
  }
})

test('unknown, oversized, nonlocal, escaped and tampered bootstrap results cannot start the helper', async t => {
  const mutations = [
    value => JSON.stringify({ ...value, token: 'private-unknown-field' }),
    () => ' '.repeat(65537),
    value => JSON.stringify({ ...value, transport: 'ssh', sshHostAlias: 'not-a-fallback', remotePython: 'C:\\python.exe', remoteHelper: 'C:\\helper.py' }),
    value => JSON.stringify({ ...value, localHelper: join(value.cwd, 'other.py') }),
    value => JSON.stringify({ ...value, helperSha256: 'b'.repeat(64) }),
  ]
  for (const mutation of mutations) {
    await t.test('reject a bootstrap result', async sub => {
      const f = await fixture(sub, { prepare(control, value) { control.finish(mutation(value)) } })
      await assert.rejects(f.bridge.resolveConfiguration(signal()), error => ['setup-required', 'helper-identity-mismatch'].includes(error.code))
      assert.equal(f.rpcs.length, 0); assert.equal(f.setups.length, 1)
    })
  }
})

test('only exact waiting-target bootstrap diagnostics are retained, without copying arbitrary stderr into logs', async t => {
  const f = await fixture(t, { prepare(control) {
    control.stderr('private https://synthetic.invalid/secret\n{"event":"waiting_target"}\n{"event":"waiting_target","raw":"private"}\n{"event":"waiting_target"}\n')
    control.finish()
  } })
  await f.bridge.resolveConfiguration(signal())
  const logs = f.ctx.logger.buffer.filter(message => message.args.some(value => typeof value === 'string' && value.includes('lvpaopao:')))
  assert.equal(logs.filter(message => message.args.includes('lvpaopao: waiting-target')).length, 1)
  assert.equal(JSON.stringify(logs).includes('private'), false); assert.equal(JSON.stringify(logs).includes('synthetic.invalid'), false)
})

test('Host disposal aborts shared setup and waits for its managed range before completing', async t => {
  const entered = Promise.withResolvers(), terminated = Promise.withResolvers()
  const f = await fixture(t, { prepare(control) { entered.resolve(control) }, deferTerminate(control) { terminated.resolve(control) } })
  const request = assert.rejects(f.bridge.resolveConfiguration(signal()), { code: 'connection-closed' })
  await entered.promise
  let disposed = false
  const disposal = f.fiber.dispose().then(() => { disposed = true })
  const control = await terminated.promise
  assert.equal(disposed, false); assert.equal(control.waits, 1)
  control.finish('', 1); await Promise.all([request, disposal])
  assert.equal(disposed, true); assert.equal(f.rpcs.length, 0)
})

test('unconfirmed setup cleanup stays visible through requests and Host disposal', async t => {
  const f = await fixture(t, { cleanup: false, prepare(control) { control.finish('', 1) } })
  await assert.rejects(f.bridge.resolveConfiguration(signal()), { code: 'setup-cleanup-unconfirmed' })
  await assert.rejects(f.bridge.dispose(), { code: 'setup-cleanup-unconfirmed' })
  assert.equal(f.rpcs.length, 0)
})

test('an unset Python executable reports setup-required without starting preparation or helper processes', async t => {
  const f = await fixture(t, { bridge: { pythonExecutable: '' } })
  await assert.rejects(f.bridge.resolveConfiguration(signal()), { code: 'setup-required' })
  assert.equal(f.setups.length, 0); assert.equal(f.rpcs.length, 0)
})


test('only an explicit status retry can prepare again after confirmed setup failure, with no business replay', async t => {
  let attempts = 0
  const f = await fixture(t, { prepare(control) { if (++attempts === 1) control.finish('', 1); else control.finish() } })
  await assert.rejects(f.bridge.request('search', { query: 'first-not-submitted' }, signal()), { code: 'setup-required' })
  await assert.rejects(f.bridge.resolveConfiguration(signal()), { code: 'setup-required' })
  assert.equal(f.setups.length, 1); assert.equal(f.rpcs.length, 0)
  assert.deepEqual(await f.bridge.request('status', {}, signal()), { operation: 'status' })
  assert.equal(f.setups.length, 2); assert.equal(f.rpcs.length, 1)
})


test('an explicit status rebuilds only an automatically owned target attestation after its failed generation is clean', async t => {
  let business = 0
  const f = await fixture(t, { nativeRequest(frame, _control, result, error) {
    if (frame.method === 'search' && ++business === 1) error('context-invalidated')
    else result({ operation: frame.method })
  } })
  await assert.rejects(f.bridge.request('search', { query: 'old-target' }, signal()), { code: 'context-invalidated' })
  assert.equal(f.setups.length, 1); assert.equal(f.rpcs.length, 1); assert.equal(f.rpcs[0].exited, true)
  await assert.rejects(f.bridge.request('detail', {}, signal()), { code: 'context-invalidated' })
  assert.equal(f.setups.length, 1); assert.equal(business, 1)
  assert.deepEqual(await f.bridge.request('status', {}, signal()), { operation: 'status' })
  assert.equal(f.setups.length, 2); assert.equal(f.rpcs.length, 2); assert.equal(f.rpcs[0].waits, 1)
  assert.equal(business, 1)
})

test('queued requests wait for fresh automatic preparation without overlapping the retired helper', async t => {
  const preparing = Promise.withResolvers(); let preparations = 0, searches = 0
  const f = await fixture(t, { prepare(control) { if (++preparations === 2) preparing.resolve(control); else control.finish() },
    nativeRequest(frame, _control, result, error) { if (frame.method === 'search' && ++searches === 1) error('context-invalidated'); else result({ operation: frame.method }) } })
  await assert.rejects(f.bridge.request('search', { query: 'old-target' }, signal()), { code: 'context-invalidated' })
  const status = f.bridge.request('status', {}, signal()), second = await preparing.promise
  const business = f.bridge.request('detail', {}, signal())
  assert.equal(f.rpcs.length, 1); assert.equal(f.rpcs[0].exited, true); assert.equal(f.setups.length, 2)
  second.finish()
  assert.deepEqual(await Promise.all([status, business]), [{ operation: 'status' }, { operation: 'detail' }])
  assert.equal(f.rpcs.length, 2); assert.equal(searches, 1)
})

test('explicit private connection settings survive terminal status recovery without automatic preparation or file replacement', async t => {
  let searches = 0
  const explicit = { sshHostAlias: 'trusted-explicit-target', remotePython: 'C:\\test\\python.exe', remoteHelper: 'C:\\test\\helper.py',
    helperSha256: 'b'.repeat(64), cwd: process.cwd() }
  const f = await fixture(t, { explicit, nativeRequest(frame, _control, result, error) {
    if (frame.method === 'search' && ++searches === 1) error('context-invalidated'); else result({ operation: frame.method })
  } })
  const before = await f.bridge.resolveConfiguration(signal())
  await assert.rejects(f.bridge.request('search', { query: 'explicit' }, signal()), { code: 'context-invalidated' })
  await f.bridge.request('status', {}, signal())
  assert.equal(await f.bridge.resolveConfiguration(signal()), before); assert.equal(f.setups.length, 0); assert.equal(f.rpcs.length, 2)
  const { readFile } = await import('node:fs/promises')
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'connection.json'), 'utf8')), explicit)
})
