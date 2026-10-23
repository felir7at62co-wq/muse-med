/** Real Sessions, initiating-Agent attribution and sandbox policy; only Windows IO is mocked. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as consumer from '../src/index.ts'
import { authorizeOutput } from '../src/output.ts'
import { BridgeError } from '../src/port.ts'

const bytes = Buffer.from('synthetic copied bytes; no native media or decode performed')
const params = { srcAppId: 'wx0123456789abcdef', dramaId: 'sample_1' }
const config = { transport: 'ssh', localPython: '', localHelper: '', sshExecutable: 'ssh-test', sshHostAlias: 'test-host', remotePython: 'C:\\Test\\python.exe',
  remoteHelper: 'C:\\Test\\helper.py', helperSha256: 'a'.repeat(64), cwd: process.cwd(),
  connectTimeoutMs: 1000, requestTimeoutMs: 1000, cancelTimeoutMs: 100, shutdownTimeoutMs: 1000,
  maxFrameBytes: 16384, maxPending: 8, maxQueryChars: 80, maxEpisodeCount: 20, maxResultItems: 50, maxSeriesEpisodes: 400,
  downloadEnabled: true, outputDir: '/must-not-use-connection-output', scpExecutable: 'scp-test', copyTimeoutMs: 1000,
  copyPollIntervalMs: 50, maxMediaBytes: 10000, downloadRequestTimeoutMs: 1000 }
function response() {
  return { operation: 'download_first_episode', status: 'download-returned', identityMatched: true, ...params,
    serialNo: 1, isFirstMediaFree: true, isStraight: true, hasPrivateMedia: true, receiptReused: true, businessCalls: 0,
    media: { relativePath: 'downloads/request-1/media/episode-01.mp4', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), durationSeconds: 1.5,
      width: 720, height: 1280, hasAudio: true, fullDecodePassed: true } }
}
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lvpaopao-session-')))
  const ctx = new Context(); const calls = [], spawns = []; let bridgeDisposed = 0
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(Agents); await ctx.plugin(Sessions); await ctx.plugin(Projections)
  await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: root })
  class Bridge extends Service {
    constructor(scope) { super(scope, 'lvpaopaoBridge'); this.configuration = options.unconfigured ? undefined : Object.freeze({ ...config }) }
    async resolveConfiguration() { if (this.configuration === undefined) throw new BridgeError('unconfigured'); return this.configuration }
    async request(action, input, signal) {
      await this.resolveConfiguration()
      calls.push({ action, input, signal })
      if (options.request) return await options.request(action, input, signal, root)
      if (action === 'download_first_episode') return response()
      return { operation: action, status: `${action}-returned`, identityMatched: true }
    }
    async dispose() { bridgeDisposed++ }
  }
  class Subprocess extends Service {
    constructor(scope) { super(scope, 'subprocess') }
    spawn(spec) {
      spawns.push(spec)
      const done = (async () => {
        if (options.copy) await options.copy(spec, root)
        else await writeFile(spec.argv.at(-1), bytes, { flag: 'wx' })
        return { exitCode: 0, signal: null }
      })()
      return { done, terminate() {}, async waitForExit() { await done; return options.rangeUnknown ? false : true } }
    }
  }
  await ctx.plugin(Bridge); await ctx.plugin(Subprocess)
  async function mount() {
    const scope = ctx.isolate('tools').isolate('systemPrompt')
    await scope.plugin(SystemPrompt); await scope.plugin(Tools)
    const fiber = scope.plugin(consumer, consumer.Config({})); await fiber.await()
    return { scope, fiber }
  }
  const mounted = await mount()
  async function session(name) {
    const cwd = join(root, name); await mkdir(cwd)
    return ctx.sessions.create(undefined, { meta: { cwd } })
  }
  let sequence = 0
  async function invoke(session, args = {}, target = mounted, signal = new AbortController().signal) {
    return await ctx.agents.withInitiator({ session, ctx: target.scope }, async () => {
      const result = await target.scope.tools.execute({ callId: `lvpaopao-${++sequence}`, name: 'lvpaopao',
        arguments: Object.fromEntries(Object.entries({ action: 'download_first_episode', ...params, ...args }).filter(([, value]) => value !== undefined)), signal })
      assert.equal(result.isError, false)
      return JSON.parse(result.content[0].text)
    })
  }
  return { ctx, root, calls, spawns, mounted, mount, session, invoke, get bridgeDisposed() { return bridgeDisposed } }
}

test('two real Session cwd values own distinct default downloads and ignore connection outputDir', async t => {
  const f = await fixture(t); const [first, second] = await Promise.all([f.session('one'), f.session('two')])
  const results = await Promise.all([f.invoke(first), f.invoke(second)])
  for (const [index, session] of [first, second].entries()) {
    const result = results[index]; assert.equal(result.ok, true)
    assert.ok(result.data.media.localPath.startsWith(join(session.header.cwd, 'downloads', 'lvpaopao') + sep))
    assert.deepEqual(await readFile(result.data.media.localPath), bytes)
  }
  assert.notEqual(results[0].data.media.localPath, results[1].data.media.localPath)
  assert.equal(f.calls.length, 2); assert.equal(f.spawns.length, 2)
  assert.deepEqual(f.calls.map(call => call.input), [params, params])
})

test('current Session read-only and workspace bounds reject before native request or directory creation', async t => {
  const f = await fixture(t); const session = await f.session('workspace')
  setSandboxMode(session, 'read-only')
  assert.equal((await f.invoke(session)).status, 'download-access-denied')
  setSandboxMode(session, 'workspace-write')
  assert.equal((await f.invoke(session, { outputDir: join(f.root, 'outside') })).status, 'download-access-denied')
  assert.equal((await f.invoke(session, { outputDir: '../outside' })).status, 'download-output-outside-workspace')
  assert.deepEqual(await readdir(session.header.cwd), [])
  assert.deepEqual(f.calls, []); assert.deepEqual(f.spawns, [])
})

test('full access accepts an explicit external absolute destination but rejects relative escape', async t => {
  const f = await fixture(t); const session = await f.session('workspace'); setSandboxMode(session, 'danger-full-access')
  const outside = join(f.root, 'requested-external')
  assert.equal((await f.invoke(session, { outputDir: '../relative-escape' })).status, 'download-output-outside-workspace')
  const result = await f.invoke(session, { outputDir: outside })
  assert.equal(result.ok, true); assert.ok(result.data.media.localPath.startsWith(outside + sep))
  assert.deepEqual(await readdir(session.header.cwd), []); assert.equal(f.calls.length, 1)
})

test('a child directory link is rejected before acquisition and cannot create its target children', async t => {
  const f = await fixture(t); const session = await f.session('workspace')
  const outside = join(f.root, 'outside'); await mkdir(outside)
  await symlink(outside, join(session.header.cwd, 'linked'), 'dir')
  const result = await f.invoke(session, { outputDir: 'linked/new-output' })
  assert.equal(result.status, 'download-output-unsafe'); assert.deepEqual(await readdir(outside), [])
  assert.equal(f.calls.length, 0); assert.equal(f.spawns.length, 0)
})

test('authorization captures an existing directory identity and refuses its replacement before mkdir', async t => {
  const f = await fixture(t); const session = await f.session('workspace')
  const anchor = join(session.header.cwd, 'anchor'); await mkdir(anchor)
  const output = await authorizeOutput(session, 'anchor/child', { mode: 'workspace-write' })
  await rename(anchor, join(session.header.cwd, 'saved-anchor')); await mkdir(anchor)
  await assert.rejects(output.create(), /download-output-replaced/)
  assert.deepEqual(await readdir(anchor), []); assert.equal(f.calls.length, 0)
})

test('replacement during native response prevents scp and never cleans someone else directory', async t => {
  const f = await fixture(t, { async request(_action, _input, _signal, root) {
    const output = join(root, 'workspace', 'downloads', 'lvpaopao')
    await rename(output, output + '-saved'); await mkdir(output)
    await writeFile(join(output, 'unrelated.txt'), 'keep')
    return response()
  } })
  const session = await f.session('workspace'); const result = await f.invoke(session)
  assert.equal(result.status, 'download-output-replaced'); assert.equal(f.calls.length, 1); assert.equal(f.spawns.length, 0)
  assert.equal(await readFile(join(session.header.cwd, 'downloads', 'lvpaopao', 'unrelated.txt'), 'utf8'), 'keep')
})

test('unconfigured scoped status is explicit and never borrows or launches a connection', async t => {
  const f = await fixture(t, { unconfigured: true }); const session = await f.session('workspace')
  const result = await f.invoke(session, { action: 'status', srcAppId: undefined, dramaId: undefined })
  assert.equal(result.ok, false); assert.equal(result.status, 'unconfigured')
  assert.equal(f.calls.length, 0); assert.equal(f.spawns.length, 0)
})

test('disposing one consumer cancels only its request, preserves bridge and leaves the second scope usable', async t => {
  const entered = Promise.withResolvers(), released = Promise.withResolvers()
  const f = await fixture(t, { async request(action, _input, signal) {
    if (action === 'search') {
      entered.resolve()
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })
      released.resolve(); signal.throwIfAborted()
    }
    return { operation: action, status: `${action}-returned`, identityMatched: true }
  } })
  const session = await f.session('workspace'), second = await f.mount()
  const work = f.invoke(session, { action: 'search', srcAppId: undefined, dramaId: undefined, query: 'synthetic' })
  await entered.promise; await f.mounted.fiber.dispose(); await released.promise
  assert.equal((await work).status, 'cancelled'); assert.equal(f.bridgeDisposed, 0)
  assert.equal(f.mounted.scope.tools.get('lvpaopao'), undefined)
  const status = await f.invoke(session, { action: 'status', srcAppId: undefined, dramaId: undefined }, second)
  assert.equal(status.ok, true); assert.equal(f.bridgeDisposed, 0); assert.equal(f.spawns.length, 0)
})

test('cancelled consumer reports unconfirmed copy cleanup and retains its disposal error without closing the bridge', async t => {
  const started = Promise.withResolvers()
  const f = await fixture(t, { rangeUnknown: true, async copy(spec) {
    await writeFile(spec.argv.at(-1), bytes, { flag: 'wx' }); started.resolve()
    await new Promise(resolve => { if (spec.signal.aborted) resolve(); else spec.signal.addEventListener('abort', resolve, { once: true }) })
  } })
  const session = await f.session('workspace'), second = await f.mount()
  const work = f.invoke(session)
  await started.promise
  const before = f.ctx.logger.buffer.length
  await f.mounted.fiber.dispose()
  const result = await work
  assert.equal(result.ok, false); assert.equal(result.status, 'download-copy-cleanup-unconfirmed')
  const output = join(session.header.cwd, 'downloads', 'lvpaopao'), folders = await readdir(output)
  assert.equal(folders.length, 1); assert.deepEqual(await readdir(join(output, folders[0])), ['episode-01.part'])
  // Cordis logs disposer failures rather than rejecting Fiber.dispose; assert its actual error channel.
  assert.ok(f.ctx.logger.buffer.slice(before).some(message => message.type === 'error'
    && message.args.some(error => error instanceof Error && error.message.includes('download-copy-cleanup-unconfirmed'))))
  assert.equal(f.bridgeDisposed, 0)
  const status = await f.invoke(session, { action: 'status', srcAppId: undefined, dramaId: undefined }, second)
  assert.equal(status.ok, true); assert.equal(f.bridgeDisposed, 0)
})
