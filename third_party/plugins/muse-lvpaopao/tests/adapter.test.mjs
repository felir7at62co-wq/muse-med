/** Offline adapter checks against built public Harness modules; no Windows or provider calls. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { Config as ConsumerConfig, registerLvpaopao } from '../src/index.ts'
import { validateConfig, remoteCommand } from '../src/config.ts'
import { projectResult, errorResult } from '../src/result.ts'
import { BridgeError } from '../src/port.ts'

const defaults = { transport: 'ssh', localPython: '', localHelper: '', sshExecutable: 'ssh', sshHostAlias: 'lvpaopao-test', remotePython: 'C:\\test\\python.exe',
  remoteHelper: 'C:\\test\\run-persistent-host.py', helperSha256: 'a'.repeat(64), cwd: process.cwd(),
  connectTimeoutMs: 1000, requestTimeoutMs: 1000, cancelTimeoutMs: 100, shutdownTimeoutMs: 100,
  maxFrameBytes: 16384, maxPending: 8, maxQueryChars: 80, maxEpisodeCount: 20, maxResultItems: 50,
  downloadEnabled: false, outputDir: '', scpExecutable: 'scp', copyTimeoutMs: 180000, copyPollIntervalMs: 100,
  maxMediaBytes: 209715200, downloadRequestTimeoutMs: 600000 }

test('setup failures explain the qualified runtime and one explicit status recovery before query retries', () => {
  for (const code of ['mac-isolated-wechat-required', 'mac-runtime-build-unsupported', 'mac-runtime-home-invalid', 'setup-timeout']) {
    const result = errorResult('search', new BridgeError(code))
    assert.equal(result.ok, false); assert.equal(result.status, code)
    assert.deepEqual(result.data, {}); assert.match(result.warnings[0], /status once/)
    assert.match(result.warnings[0], /native business request was submitted/)
  }
})

test('scoped consumer configuration exposes model limits without Windows or output coordinates', () => {
  assert.deepEqual(ConsumerConfig({}), { maxQueryChars: 80, maxEpisodeCount: 20, maxResultItems: 50,
    maxSeriesEpisodes: 400, maxAttempts: 3, retryDelayMs: 1000, seriesLockWaitMs: 5000, copyChunkBytes: 1048576 })
  assert.deepEqual(Object.keys(ConsumerConfig.dict).sort(), ['copyChunkBytes', 'maxAttempts', 'maxEpisodeCount', 'maxQueryChars', 'maxResultItems', 'maxSeriesEpisodes', 'retryDelayMs', 'seriesLockWaitMs'])
  assert.throws(() => ConsumerConfig({ maxEpisodeCount: 21 }))
})

test('configuration rejects host injection and invalid bounds before a process can start', () => {
  assert.ok(Object.isFrozen(validateConfig(defaults)))
  for (const patch of [{ sshHostAlias: 'host; secret' }, { remoteHelper: 'relative.py' },
    { helperSha256: 'bad' }, { maxPending: 0 }, { requestTimeoutMs: Infinity }, { remotePython: 'C:\\test\nsecret' }]) {
    assert.throws(() => validateConfig({ ...defaults, ...patch }), /lvpaopao:/)
  }
  const command = remoteCommand(defaults)
  assert.match(command, /^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/)
  const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le')
  assert.match(script, /Get-FileHash -LiteralPath/); assert.match(script, /--rpc-stdio/)
  assert.equal(script.includes('query'), false)
})

test('model projection retains actual partial episodes and removes signed URL or private fields', () => {
  const result = projectResult('episodes', { operation: 'episodes', status: 'episodes-returned', identityMatched: true,
    requestedStart: 1, requestedEndExclusive: 20, episodeNumbers: [1, 2, 3], partial: true,
    privateResult: { mediaUrl: 'https://private.example/signed-secret' }, _privateMediaUrl: 'private-secret' }, defaults)
  assert.equal(result.ok, true); assert.deepEqual(result.data.episodeNumbers, [1, 2, 3])
  assert.equal(result.data.requestedEndExclusive, 20); assert.match(result.warnings[0], /not a complete-series/)
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.throws(() => projectResult('episodes', { operation: 'episodes', status: 'episodes-returned', episodeNumbers: [1, 1] }, defaults))
  assert.throws(() => projectResult('search', { operation: 'detail', status: 'detail-returned' }, defaults))
})

test('download is explicitly unaccepted even if a helper returns apparent success', () => {
  const result = projectResult('download_first_episode', { operation: 'download_first_episode', status: 'download-returned',
    identityMatched: true, serialNo: 1, isStraight: true, hasPrivateMedia: true }, defaults)
  assert.equal(result.ok, false); assert.match(result.warnings[0], /no verified local file/)
})

test('failure diagnostics allow only fixed categories and an own int32 or null native code', () => {
  const failure = { operation: 'search', status: 'native-call-failed', identityMatched: true,
    failurePhase: 'response-received', failureKind: 'TypeError', nativeErrorCode: -2147483648,
    errText: 'https://private.example/signed-secret', stack: 'private-stack' }
  const result = projectResult('search', failure, defaults)
  assert.equal(result.ok, false)
  assert.equal(result.data.failurePhase, 'response-received')
  assert.equal(result.data.failureKind, 'TypeError')
  assert.equal(result.data.nativeErrorCode, -2147483648)
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(projectResult('search', { ...failure, nativeErrorCode: null }, defaults).data.nativeErrorCode, null)
  assert.equal(projectResult('search', { ...failure, nativeErrorCode: 2147483647 }, defaults).data.nativeErrorCode, 2147483647)
  for (const patch of [{ nativeErrorCode: 'https://private.example/signed-secret' }, { nativeErrorCode: '123' },
    { nativeErrorCode: 2147483648 }, { nativeErrorCode: -2147483649 }, { nativeErrorCode: 1.5 },
    { failurePhase: 'https://private.example/signed-secret' }, { failureKind: 'private-error-text' }]) {
    assert.throws(() => projectResult('search', { ...failure, ...patch }, defaults), /invalid-response/)
  }
  const inherited = Object.assign(Object.create({ nativeErrorCode: 123 }), { operation: 'search', status: 'native-call-failed' })
  assert.equal(Object.hasOwn(projectResult('search', inherited, defaults).data, 'nativeErrorCode'), false)
  assert.equal(Object.hasOwn(projectResult('search', { operation: 'search', status: 'search-returned',
    identityMatched: true }, defaults).data, 'failurePhase'), false)
})

test('waiting target is a useful lifecycle response only for the exact configured AppID', () => {
  const waiting = { status: 'waiting_target', ready: false, expectedAppId: 'wx404dde55fb12df78' }
  const result = projectResult('status', waiting, defaults)
  assert.equal(result.ok, true); assert.equal(result.status, 'waiting-target'); assert.equal(result.data.ready, false)
  assert.match(result.warnings[0], /Open or reopen/)
  assert.throws(() => projectResult('status', { ...waiting, expectedAppId: 'wx0000000000000000' }, defaults))
  assert.throws(() => projectResult('status', { ...waiting, ready: true }, defaults))
  assert.throws(() => projectResult('status', { ...waiting, privateResult: 'secret' }, defaults))
})

test('accepted status reports readiness even when auxiliary business login state is false', () => {
  const value = { operation: 'status', status: 'status-returned', identityMatched: true, hostLoginState: false, timedOut: false }
  const result = projectResult('status', value, defaults)
  assert.equal(result.ok, true); assert.equal(result.data.ready, true)
  assert.equal(result.data.hostLoginState, false); assert.match(result.warnings[0], /not desktop WeChat login/)
  for (const patch of [{ identityMatched: false }, { timedOut: true }, { status: 'native-wrapper-unavailable' }]) {
    const failure = projectResult('status', { ...value, ...patch }, defaults)
    assert.equal(failure.ok, false); assert.equal(failure.data.ready, false)
  }
})

test('real Loader registers the typed tool, ToolRuntime exposes safe JSON, and disposal removes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lvpaopao-loader-'))
  const calls = []; let disposals = 0
  const port = { async request(action, params, signal) {
    assert.equal(signal.aborted, false); calls.push({ action, params })
    if (action === 'search' && (params.query === 'diag-null' || params.query === 'diag-int')) {
      return { operation: action, status: 'native-call-failed', identityMatched: true,
        failurePhase: 'response-received', failureKind: 'TypeError', nativeErrorCode: params.query === 'diag-null' ? null : -7,
        errText: 'https://private.example/signed-secret', rawURL: 'https://private.example/signed-secret' }
    }
    if (action === 'detail') return { operation: action, status: 'detail-returned', identityMatched: true,
      srcAppId: 'wx0000000000000000', dramaId: params.dramaId, title: 'Other drama' }
    return { operation: action, status: 'search-returned', identityMatched: true, resultCount: 26, partial: true,
      candidates: [{ title: '老手', srcAppId: 'wx6522458df7ed3af2', originDramaId: '121225' }], privateResult: { token: 'never-visible' } }
  }, async dispose() { disposals++ } }
  const plugin = { name: 'muse-lvpaopao-test-port', inject: ['tools'], apply(ctx) { registerLvpaopao(ctx, port, defaults) } }
  const ctx = new Context()
  try {
    const config = join(directory, 'cordis.yml')
    await writeFile(config, "- name: prompt\n- name: tools\n- name: adapter\n")
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    await ctx.plugin(Loader); ctx.loader.builtins.include = Include
    const modules = new Map([['prompt', SystemPrompt], ['tools', Tools], ['adapter', plugin]])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw Error('unused') }, getOrCreateModuleJob() { throw Error('unused') },
      resolveSync() { throw Error('unused') }, load() { throw Error('unused') },
      async import(specifier) { assert.ok(modules.has(specifier)); return modules.get(specifier) },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await(); for (const row of ctx.loader.entries()) await row.fiber?.await()
    assert.ok(ctx.tools.get('lvpaopao'))
    const result = await ctx.tools.execute({ callId: 'lvpaopao-call', name: 'lvpaopao',
      arguments: { action: 'search', query: '老手' }, signal: new AbortController().signal })
    assert.equal(result.isError, false)
    const visible = JSON.parse(result.content[0].text)
    assert.equal(visible.ok, true); assert.equal(visible.data.resultCount, 26)
    assert.equal(JSON.stringify(result).includes('never-visible'), false)
    const invalid = await ctx.tools.execute({ callId: 'lvpaopao-invalid', name: 'lvpaopao',
      arguments: { action: 'search', query: '老手', srcAppId: 'wx0000000000000000' }, signal: new AbortController().signal })
    assert.equal(JSON.parse(invalid.content[0].text).status, 'invalid-arguments')
    assert.equal(calls.length, 1)
    const misplacedOutput = await ctx.tools.execute({ callId: 'lvpaopao-read-output', name: 'lvpaopao',
      arguments: { action: 'search', query: 'synthetic', outputDir: '/unrelated' }, signal: new AbortController().signal })
    assert.equal(JSON.parse(misplacedOutput.content[0].text).status, 'invalid-arguments')
    assert.equal(calls.length, 1)
    const mismatch = await ctx.tools.execute({ callId: 'lvpaopao-wrong-source', name: 'lvpaopao',
      arguments: { action: 'detail', srcAppId: 'wx6522458df7ed3af2', dramaId: '121225' }, signal: new AbortController().signal })
    assert.equal(JSON.parse(mismatch.content[0].text).status, 'response-identity-mismatch')
    for (const [query, nativeErrorCode] of [['diag-null', null], ['diag-int', -7]]) {
      const diagnostic = await ctx.tools.execute({ callId: `lvpaopao-${query}`, name: 'lvpaopao',
        arguments: { action: 'search', query }, signal: new AbortController().signal })
      assert.equal(diagnostic.isError, false)
      const visibleDiagnostic = JSON.parse(diagnostic.content[0].text)
      assert.equal(visibleDiagnostic.ok, false)
      assert.equal(visibleDiagnostic.status, 'native-call-failed')
      assert.deepEqual(visibleDiagnostic.data, { failurePhase: 'response-received', failureKind: 'TypeError',
        nativeErrorCode, identityMatched: true })
      assert.equal(JSON.stringify(diagnostic).includes('https://'), false)
      assert.equal(JSON.stringify(diagnostic).includes('rawURL'), false)
      assert.equal(JSON.stringify(diagnostic).includes('errText'), false)
    }
    const entry = [...ctx.loader.entries()].find(row => row.options.name === 'adapter')
    await entry.fiber.dispose(); assert.equal(ctx.tools.get('lvpaopao'), undefined); assert.equal(disposals, 1)
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

export { defaults }
