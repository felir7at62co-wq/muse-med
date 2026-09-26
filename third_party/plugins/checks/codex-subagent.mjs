/** Copied beside staged src by build.mjs; only CLI --version reaches a real process. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as runtime from './src/subagent-runtime.js'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { inspectSubagentRuntime, loadSubagentRuntime, SUBAGENT_RUNTIME_VERSION } from './src/subagent-runtime.js'
import { authenticatedSubagentChild } from './src/subagent-auth.js'
import { createRuntimeManagement } from './src/runtime-management.js'

const approvedVersion = '0.1.6-alpha.2'

test('runs the real current provider and authenticated transport against a local protocol peer', async () => {
  const official = await import('@deepseek-ai/dsh-subagent-codex')
  const { JsonRpcLineTransport: Transport } = await import('@deepseek-ai/dsh-sdk-protocol')
  assert.equal(typeof official.apply, 'function')
  assert.deepEqual(official.inject, ['subagents', 'subprocess'])
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  const done = Promise.withResolvers()
  const server = new Transport(stdin, stdout)
  const observed = []
  const thread = { model: 'test-model', modelProvider: 'openai', approvalPolicy: 'never', sandbox: 'read-only', config: {} }
  const signal = AbortSignal.timeout(10_000)
  let terminated = false
  const child = {
    stdin, stdout, stderr, done: done.promise,
    terminate() { terminated = true; done.resolve({ exitCode: 0, signal: null }) },
    async waitForExit() { await done.promise; return true },
  }
  server.onRequest((method, params) => {
    observed.push(method)
    if (method === 'initialize') { assert.equal(params.capabilities.experimentalApi, true); return {} }
    if (method === 'account/login/start') {
      assert.deepEqual(params, { type: 'chatgptAuthTokens', accessToken: 'fixture-token', chatgptAccountId: 'fixture-account' })
      return {}
    }
    if (method === 'thread/start') {
      assert.equal(params.ephemeral, true)
      for (const [key, value] of Object.entries(thread)) assert.deepEqual(params[key], value)
      return { thread: { id: 'fixture-thread', ephemeral: true } }
    }
    if (method === 'turn/start') {
      assert.equal(params.threadId, 'fixture-thread')
      assert.equal(params.input[0].text, 'fixture task')
      server.notify('item/completed', { threadId: 'fixture-thread', turnId: 'fixture-turn', item: { type: 'agentMessage', phase: 'final_answer', text: 'fixture result' } })
      server.notify('turn/completed', { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } })
      return { turn: { id: 'fixture-turn' } }
    }
    throw new Error(`Unexpected fixture method: ${method}`)
  })
  server.start()
  let provider, run
  try {
    official.apply({
      subagents: { registerProvider(value) { provider = value } },
      subprocess: { spawn(spec) {
        assert.equal(spec.argv[0], process.execPath)
        assert.deepEqual(spec.argv.slice(-2), ['app-server', '--stdio'])
        assert.equal(JSON.stringify(spec).includes('fixture-token'), false)
        return authenticatedSubagentChild(child, { Transport, signal, thread, getTokens: async () => ({ accessToken: 'fixture-token', chatgptAccountId: 'fixture-account' }) })
      } },
      logger: { warn(message) { assert.fail(message) } },
    }, { model: 'test-model', env: {}, permissionMode: 'never', disposeGraceMs: 1000 })
    run = await provider.start({ parent: { session: { header: { cwd: process.cwd() } } }, prompt: [{ type: 'text', text: 'fixture task' }], signal })
    assert.deepEqual(await run.result, { output: [{ type: 'text', text: 'fixture result' }], stopReason: 'completed' })
    assert.deepEqual(observed, ['initialize', 'account/login/start', 'thread/start', 'turn/start'])
    await run.dispose()
    assert.equal(terminated, true)
    await child.done
  } finally {
    await run?.dispose()
    child.terminate()
    server.close()
    stdin.destroy(); stdout.destroy(); stderr.destroy()
  }
})

test('inspects and loads the actual current package and its provider-local CLI', async () => {
  assert.deepEqual(inspectSubagentRuntime(), { installed: true })
  const { official, Transport } = await loadSubagentRuntime()
  assert.equal(official.apply, (await import('@deepseek-ai/dsh-subagent-codex')).apply)
  assert.equal(Transport, (await import('@deepseek-ai/dsh-sdk-protocol')).JsonRpcLineTransport)
})

test('rejects unreviewed and obsolete runtimes before importing or executing them', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'muse-codex-version-'))
  try {
    const manifest = join(temporary, 'package.json')
    const resolve = () => manifest
    for (const version of ['0.1.5-rc.2', '0.1.5-rc.3', '0.1.6-alpha.1', '9.9.9']) {
      writeFileSync(manifest, JSON.stringify({ version }))
      assert.deepEqual(inspectSubagentRuntime(resolve), { installed: false, present: true })
      await assert.rejects(loadSubagentRuntime({ resolve, run: () => assert.fail('must not launch'), importModule: () => assert.fail('must not import') }), /not prepared/)
    }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('maps only an exact app.asar directory segment for native CLI files', () => {
  const map = runtime.codexFilesystemPath
  assert.equal(typeof map, 'function')
  assert.equal(map('/product/app.asar/node_modules/codex/package.json'), '/product/app.asar.unpacked/node_modules/codex/package.json')
  assert.equal(map(String.raw`C:\product\app.asar\node_modules\codex\package.json`), String.raw`C:\product\app.asar.unpacked\node_modules\codex\package.json`)
  for (const path of ['/source/node_modules/codex/package.json', '/x/my-app.asar/package.json', '/x/app.asar-backup/package.json', '/x/app.asar.unpacked/package.json']) assert.equal(map(path), path)
})

test('reads the unpacked CLI manifest before composing its physical wrapper path', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'muse-codex-asar-'))
  const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
  try {
    const entry = join(temporary, 'app.asar/provider/index.js')
    const providerManifest = join(temporary, 'provider.json')
    put(providerManifest, JSON.stringify({ version: approvedVersion }))
    put(join(temporary, 'app.asar/node_modules/@openai/codex/package.json'), JSON.stringify({ version: 'invalid-archive-copy', bin: { codex: 'wrong.js' } }))
    put(join(temporary, 'app.asar.unpacked/node_modules/@openai/codex/package.json'), JSON.stringify({ version: '0.153.4', bin: { codex: 'bin/codex.js' } }))
    const wrapper = join(temporary, 'app.asar.unpacked/node_modules/@openai/codex/bin/codex.js')
    put(wrapper, '// fixture wrapper')
    put(join(temporary, 'app.asar/node_modules/@deepseek-ai/dsh-sdk-protocol/package.json'), JSON.stringify({ main: 'index.js' }))
    put(join(temporary, 'app.asar/node_modules/@deepseek-ai/dsh-sdk-protocol/index.js'), '')
    let calls = 0
    await loadSubagentRuntime({
      resolve: name => name.endsWith('/package.json') ? providerManifest : entry,
      run: async (command, argv) => {
        calls++
        assert.equal(command, process.execPath)
        assert.deepEqual(argv, [wrapper, '--version'])
        assert.equal(readFileSync(argv[0], 'utf8'), '// fixture wrapper')
        return { stdout: 'codex-cli 0.153.4\n' }
      },
      importModule: url => import(url.endsWith('/provider/index.js') ? '@deepseek-ai/dsh-subagent-codex' : '@deepseek-ai/dsh-sdk-protocol'),
    })
    assert.equal(calls, 1)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('runtime preparation targets the same exact approved product provider', async () => {
  assert.equal(SUBAGENT_RUNTIME_VERSION, approvedVersion)
  const installs = []
  const management = createRuntimeManagement({
    manager: () => ({
      listBundles: async () => [],
      installBundle: async (spec) => { installs.push(spec); return { application: 'applied' } },
      removeBundle: () => assert.fail('no removal'), cancelInstall: () => assert.fail('no cancellation'),
    }),
    inspect: inspectSubagentRuntime, active: () => 0, selectDsh: () => assert.fail('no switch'),
  })
  await management.start('install')
  assert.deepEqual(installs, [`@deepseek-ai/dsh-subagent-codex@${approvedVersion}`])
})
