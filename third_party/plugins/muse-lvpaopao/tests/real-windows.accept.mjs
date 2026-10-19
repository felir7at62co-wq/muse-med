/** Explicit test-only acceptance fixture. Nothing connects without --execute. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, lstat, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
const built = process.env.DSH_EXAMPLE_MODE === 'lib'
const installation = createRequire(new URL('../../../../apps/cli/package.json', import.meta.url))
const harness = name => import(built ? pathToFileURL(installation.resolve(name)).href : name)
const { Context } = await harness('@deepseek-ai/cordis')
const { default: Loader } = await harness('@deepseek-ai/cordis-plugin-loader')
const { default: Include } = await harness('@deepseek-ai/cordis-plugin-include')
const { default: Tools } = await harness('@deepseek-ai/dsh-tools')
const { default: SystemPrompt } = await harness('@deepseek-ai/dsh-system-prompt')
const { default: LocalSubprocess } = await harness('@deepseek-ai/dsh-subprocess-local')
const { default: Agents } = await harness('@deepseek-ai/dsh-agent')
const { default: Sessions } = await harness('@deepseek-ai/dsh-session')
const { default: Projections } = await harness('@deepseek-ai/dsh-session-projection')
const { default: SandboxPolicy, setSandboxMode } = await harness('@deepseek-ai/dsh-sandbox-policy')
const Adapter = await import(built ? '../lib/index.js' : '../src/index.ts')
const { default: SharedBridge } = await import(built ? '../lib/bridge.js' : '../src/bridge.ts')

function options(argv) {
  const values = {}; let execute = false; let download = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--execute') { execute = true; continue }
    if (argv[i] === '--download') { download = true; continue }
    if (!['--config', '--output', '--workspace', '--wait-ms', '--poll-ms'].includes(argv[i]) || !argv[i + 1]) throw Error('invalid-arguments')
    if (values[argv[i]] !== undefined) throw Error('duplicate-arguments')
    values[argv[i]] = argv[++i]
  }
  if (!execute) return { execute: false }
  if (!values['--config'] || !values['--output']) throw Error('config-and-output-required')
  const waitMs = Number(values['--wait-ms'] ?? 600000), pollMs = Number(values['--poll-ms'] ?? 2000)
  if (!Number.isSafeInteger(waitMs) || waitMs < 1000 || waitMs > 600000
    || !Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 10000) throw Error('invalid-bounds')
  return { execute, download, config: resolve(values['--config']), output: resolve(values['--output']),
    workspace: resolve(values['--workspace'] ?? process.cwd()), waitMs, pollMs }
}

async function run(args) {
  try { await lstat(args.output); throw Error('output-already-exists') }
  catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error }
  const inputInfo = await lstat(args.config)
  if (!inputInfo.isFile() || inputInfo.isSymbolicLink() || (process.platform !== 'win32' && (inputInfo.mode & 0o077) !== 0)) throw Error('private-config-required')
  const workspaceInfo = await lstat(args.workspace)
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) throw Error('workspace-directory-required')
  const directory = await mkdtemp(join(tmpdir(), 'lvpaopao-real-accept-')); await chmod(directory, 0o700)
  const ctx = new Context(); const controller = new AbortController()
  const receipt = { kind: 'actual-public-adapter-acceptance', status: 'started',
    loader: true, toolRuntime: true, publicSubprocessLocal: true, spawnInstrumentationOnly: true,
    realSession: true, sharedBridge: true, sessionSandbox: 'workspace-write',
    sshLaunches: 0, copyLaunches: 0, statusCalls: 0, calls: [], downloadCalls: 0, nativeUiAutomation: false,
    cleanup: false, elapsedSeconds: null }
  const started = Date.now()
  const stop = () => controller.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  let transport
  class ObservedLocal extends LocalSubprocess {
    spawn(spec) {
      if (spec.argv[0] === transport?.sshExecutable) receipt.sshLaunches++
      else if (spec.argv[0] === transport?.scpExecutable) receipt.copyLaunches++
      return super.spawn(spec)
    }
  }
  try {
    const yaml = join(directory, 'cordis.yml')
    await writeFile(yaml, JSON.stringify([
      { name: 'prompt' }, { name: 'tools' }, { name: 'agents' }, { name: 'sessions' }, { name: 'projections' },
      { name: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: args.workspace } },
      { name: 'subprocess' }, { name: 'shared-bridge', config: { connectionFile: args.config } },
      { name: 'adapter', config: {} },
    ]), { mode: 0o600 })
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    await ctx.plugin(Loader); ctx.loader.builtins.include = Include
    const modules = new Map([['prompt', SystemPrompt], ['tools', Tools], ['agents', Agents], ['sessions', Sessions],
      ['projections', Projections], ['sandbox-policy', SandboxPolicy], ['subprocess', ObservedLocal],
      ['shared-bridge', SharedBridge], ['adapter', Adapter]])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw Error('unused-loader-api') }, getOrCreateModuleJob() { throw Error('unused-loader-api') },
      resolveSync() { throw Error('unused-loader-api') }, load() { throw Error('unused-loader-api') },
      async import(specifier) { if (!modules.has(specifier)) throw Error('unexpected-module'); return modules.get(specifier) },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(yaml).href } })
    await ctx.loader.await(); for (const row of ctx.loader.entries()) await row.fiber?.await()
    assert.ok(ctx.tools.get('lvpaopao'))
    transport = ctx.lvpaopaoBridge.configuration
    assert.ok(transport); assert.equal(receipt.sshLaunches, 0)
    if (args.download && !transport.downloadEnabled) throw Error('download-lane-disabled')
    const session = ctx.sessions.create(undefined, { meta: { cwd: args.workspace } })
    setSandboxMode(session, 'workspace-write')
    // This test driver supplies a real Session to the public initiator scope; it makes no model request.
    const agent = { session, ctx }
    async function call(action, params = {}) {
      const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
        callId: `real-lvpaopao-${receipt.calls.length + receipt.statusCalls + 1}`,
        name: 'lvpaopao', arguments: { action, ...params }, signal: controller.signal }))
      if (result.isError || result.content.length !== 1 || result.content[0].type !== 'text') throw Error('tool-result-invalid')
      const value = JSON.parse(result.content[0].text)
      if (value.action !== action || typeof value.ok !== 'boolean') throw Error('canonical-result-invalid')
      if (action === 'status') receipt.statusCalls++
      else { receipt.calls.push(value); if (action === 'download_first_episode') receipt.downloadCalls++ }
      return value
    }
    const deadline = Date.now() + args.waitMs
    let ready = false; let waitingPrinted = false
    while (Date.now() < deadline) {
      const value = await call('status')
      if (value.ok && value.status === 'status-returned' && value.data.identityMatched === true) { ready = true; break }
      if (value.status !== 'waiting-target') throw Error('unexpected-readiness-state')
      if (!waitingPrinted) {
        waitingPrinted = true; receipt.waitingObserved = true
        process.stdout.write(JSON.stringify({ type: 'adapter-waiting-target', nativeUiAutomation: false }) + '\n')
      }
      await delay(args.pollMs, undefined, { signal: controller.signal })
    }
    if (!ready) throw Error('target-readiness-deadline')
    process.stdout.write(JSON.stringify({ type: 'adapter-ready' }) + '\n')
    const search = await call('search', { query: '老手' })
    assert.equal(search.ok, true)
    assert.ok(search.data.candidates.some(item => item.title === '老手' && item.srcAppId === 'wx6522458df7ed3af2' && item.originDramaId === '121225'))
    const selection = { srcAppId: 'wx6522458df7ed3af2', dramaId: '121225' }
    const detail = await call('detail', selection)
    assert.equal(detail.ok, true); assert.equal(detail.data.title, '老手'); assert.equal(detail.data.episodeCount, 36)
    const episodes = await call('episodes', { ...selection, start: 1, count: 20 })
    assert.equal(episodes.ok, true); assert.ok(episodes.data.episodeNumbers.length > 0)
    assert.ok(episodes.data.episodeNumbers.every(number => Number.isInteger(number) && number >= 1 && number <= 20))
    const second = await call('episodes', { ...selection, start: 21, count: 20 })
    assert.equal(second.ok, true)
    const actual = [...new Set([...episodes.data.episodeNumbers, ...second.data.episodeNumbers])].sort((a, b) => a - b)
    receipt.sameDeclaredEpisodeCount = episodes.data.episodeCount === detail.data.episodeCount && second.data.episodeCount === detail.data.episodeCount
    receipt.fullCatalogAccepted = receipt.sameDeclaredEpisodeCount && second.data.requestedStart === 21
      && second.data.episodeNumbers.every(number => number >= 21 && number <= 36)
      && actual.length === 36 && actual.every((number, index) => number === index + 1)
    receipt.actualEpisodeNumbers = actual
    if (args.download) {
      const downloaded = await call('download_first_episode', selection)
      assert.equal(downloaded.ok, true); assert.equal(downloaded.data.receiptReused, true); assert.equal(downloaded.data.businessCalls, 0)
      assert.equal(downloaded.data.media.sha256, 'c487de2ce9668f03ac15c8c93e73db1c7548f66d6e3fa147801f56fb5c7f0b18')
      assert.equal(downloaded.data.media.bytes, 23604611)
      assert.equal((await lstat(downloaded.data.media.localPath)).size, downloaded.data.media.bytes)
      assert.equal(JSON.parse(await readFile(downloaded.data.media.receiptPath, 'utf8')).receiptReused, true)
      const path = relative(resolve(args.workspace, 'downloads', 'lvpaopao'), downloaded.data.media.localPath)
      assert.ok(path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
      assert.equal(receipt.copyLaunches, 1)
    }
    assert.equal(receipt.sshLaunches, 1); assert.equal(receipt.calls.length, args.download ? 5 : 4)
    receipt.status = 'operations-accepted'
  } catch (error) {
    receipt.status = 'not-accepted'; receipt.errorType = error?.constructor?.name ?? 'Error'
    process.exitCode = 1
  } finally {
    controller.abort(); process.off('SIGINT', stop); process.off('SIGTERM', stop)
    try {
      const adapter = [...ctx.loader.entries()].find(row => row.options.name === 'adapter')
      if (adapter?.fiber !== undefined) await adapter.fiber.dispose()
      assert.equal(ctx.tools.get('lvpaopao'), undefined)
      receipt.consumerLeftBridgeAlive = ctx.get('lvpaopaoBridge') !== undefined
      await ctx.fiber.dispose(); receipt.cleanup = true
    } catch (error) {
      receipt.cleanupErrorType = error?.constructor?.name ?? 'Error'; receipt.status = 'not-accepted'; process.exitCode = 1
      try { await ctx.fiber.dispose() } catch (secondError) { void secondError }
    }
    receipt.elapsedSeconds = Math.round((Date.now() - started) / 10) / 100
    await writeFile(args.output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rm(directory, { recursive: true, force: true })
    process.stdout.write(JSON.stringify({ type: 'adapter-acceptance-finished', status: receipt.status,
      sshLaunches: receipt.sshLaunches, statusCalls: receipt.statusCalls, businessOperations: receipt.calls.length,
      downloadCalls: receipt.downloadCalls, fullCatalogAccepted: receipt.fullCatalogAccepted ?? false, cleanup: receipt.cleanup }) + '\n')
  }
}

try {
  const args = options(process.argv.slice(2))
  if (!args.execute) process.stdout.write(JSON.stringify({ type: 'prepared-not-executed', requires: '--execute --config <private-json> --output <new-receipt> [--workspace <existing-directory>]', sshLaunches: 0 }) + '\n')
  else await run(args)
} catch (error) {
  process.stdout.write(JSON.stringify({ type: 'adapter-acceptance-failed', errorType: error?.constructor?.name ?? 'Error' }) + '\n')
  process.exitCode = 1
}
