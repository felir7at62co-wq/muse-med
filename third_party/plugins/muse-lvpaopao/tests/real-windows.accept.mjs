/** Explicit test-only acceptance fixture. Nothing connects without --execute. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, lstat, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
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
  const values = {}; let execute = false; let download = false; let series = false; let reconcileProbes = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--execute') { execute = true; continue }
    if (argv[i] === '--download') { download = true; continue }
    if (argv[i] === '--series') { series = true; continue }
    if (argv[i] === '--reconcile-probes') { reconcileProbes = true; continue }
    if (!['--config', '--output', '--workspace', '--wait-ms', '--poll-ms'].includes(argv[i]) || !argv[i + 1]) throw Error('invalid-arguments')
    if (values[argv[i]] !== undefined) throw Error('duplicate-arguments')
    values[argv[i]] = argv[++i]
  }
  if (!execute) return { execute: false }
  if (!values['--config'] || !values['--output']) throw Error('config-and-output-required')
  const waitMs = Number(values['--wait-ms'] ?? 600000), pollMs = Number(values['--poll-ms'] ?? 2000)
  if (!Number.isSafeInteger(waitMs) || waitMs < 1000 || waitMs > 600000
    || !Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 10000) throw Error('invalid-bounds')
  if (reconcileProbes && !series) throw Error('series-required')
  return { execute, download, series, reconcileProbes, config: resolve(values['--config']), output: resolve(values['--output']),
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
    sshLaunches: 0, localLaunches: 0, copyLaunches: 0, statusCalls: 0, calls: [], downloadCalls: 0, nativeMethods: [], processes: [], nativeUiAutomation: false,
    cleanup: false, elapsedSeconds: null }
  const started = Date.now()
  const stop = () => controller.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  let transport
  class ObservedLocal extends LocalSubprocess {
    spawn(spec) {
      if (spec.argv[0] === transport?.sshExecutable) receipt.sshLaunches++
      else if (spec.argv[0] === transport?.localPython) receipt.localLaunches++
      else if (spec.argv[0] === transport?.scpExecutable) receipt.copyLaunches++
      const handle = super.spawn(spec)
      const facts = { kind: spec.argv[0] === transport?.localPython ? 'local-helper' : spec.argv[0] === transport?.sshExecutable ? 'ssh-helper' : 'copy',
        exits: [], rangeChecks: [], closedEvents: [], errors: [] }
      receipt.processes.push(facts)
      let buffered = ''
      handle.stdout?.on('data', chunk => {
        buffered += chunk.toString('utf8')
        if (buffered.length > 1048576) { buffered = ''; return }
        for (;;) {
          const newline = buffered.indexOf('\n'); if (newline < 0) break
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1)
          try {
            const frame = JSON.parse(line)
            if (frame.protocol === 1 && frame.type === 'event' && frame.event === 'closed') {
              const status = typeof frame.details?.status === 'string' && /^[a-z][a-z0-9-]{0,95}$/.test(frame.details.status) ? frame.details.status : 'unrecognized'
              facts.closedEvents.push({ status, ...Object.fromEntries(['dispose', 'unload', 'detach', 'serverClosed'].map(key => [key, frame.details?.cleanup?.[key] === true])) })
            }
            if (frame.protocol === 1 && frame.type === 'error' && typeof frame.error?.code === 'string'
              && /^[a-z][a-z0-9-]{0,95}$/.test(frame.error.code)) facts.errors.push(frame.error.code)
          } catch (error) { void error; /* The observer retains no raw protocol text. */ }
        }
      })
      void handle.done.then(outcome => facts.exits.push({ exitCode: outcome.exitCode, signal: outcome.signal }), () => facts.exits.push({ rejected: true }))
      const wait = handle.waitForExit.bind(handle)
      handle.waitForExit = async signal => { const gone = await wait(signal); facts.rangeChecks.push(gone); return gone }
      return handle
    }
  }
  class ObservedBridge extends SharedBridge {
    async request(action, params, signal) { receipt.nativeMethods.push(action); return await super.request(action, params, signal) }
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
      ['shared-bridge', ObservedBridge], ['adapter', Adapter]])
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
    if (args.series) { assert.equal(process.platform, 'win32'); assert.equal(transport.transport, 'local') }
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
    const second = await call('episodes', { ...selection, start: 21, count: 16 })
    assert.equal(second.ok, true)
    const actual = [...new Set([...episodes.data.episodeNumbers, ...second.data.episodeNumbers])].sort((a, b) => a - b)
    receipt.sameDeclaredEpisodeCount = episodes.data.episodeCount === detail.data.episodeCount && second.data.episodeCount === detail.data.episodeCount
    receipt.fullCatalogAccepted = receipt.sameDeclaredEpisodeCount && second.data.requestedStart === 21
      && second.data.episodeNumbers.every(number => number >= 21 && number <= 36)
      && actual.length === 36 && actual.every((number, index) => number === index + 1)
    receipt.actualEpisodeNumbers = actual
    if (args.series) {
      const rankings = await call('rankings')
      assert.equal(rankings.ok, true); assert.ok(rankings.data.entries.length > 0)
      receipt.rankings = rankings
      const ranked = rankings.data.entries[0]
      const rankedDetail = await call('detail', { srcAppId: ranked.srcAppId, dramaId: ranked.originDramaId })
      assert.equal(rankedDetail.ok, true); assert.equal(rankedDetail.data.title, ranked.title)
      receipt.rankedSourceAccepted = true
      if (args.reconcileProbes) {
        assert.equal(receipt.fullCatalogAccepted, true)
        const taskId = createHash('sha256').update(JSON.stringify([selection.srcAppId, selection.dramaId])).digest('hex').slice(0, 24)
        const taskDirectory = join(args.workspace, 'downloads', 'lvpaopao', `lvpaopao-${taskId}`)
        const manifestPath = join(taskDirectory, 'manifest.json')
        let present = false
        try { await lstat(manifestPath); present = true } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (!present) {
          await mkdir(taskDirectory, { recursive: true, mode: 0o700 })
          const episodes = actual.map(episodeNo => ({ episodeNo,
            state: episodeNo <= 2 ? 'unknown' : 'pending', attempts: episodeNo <= 2 ? 1 : 0,
            requestKey: episodeNo <= 2 ? createHash('sha256').update(`muse-lvpaopao-series-20261019|${selection.srcAppId}|${selection.dramaId}|${episodeNo}|v1`).digest('hex') : randomBytes(32).toString('hex'),
            ...(episodeNo <= 2 ? { retry: 'unknown', lastError: 'series-interrupted' } : {}) }))
          await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, taskId,
            selection: { ...selection, title: detail.data.title, episodeCount: 36, actualEpisodeNumbers: actual, catalogComplete: true }, episodes }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
          receipt.importedProbeKeys = true; receipt.importedCompletedClaims = 0
        }
      }
      let task = await call('download_series', { query: '老手' })
      if (task.status === 'selection-required') {
        const exact = task.data.candidates.filter(item => item.title === '老手' && item.srcAppId === selection.srcAppId && item.originDramaId === selection.dramaId)
        assert.equal(exact.length, 1)
        task = await call('download_series', selection)
      }
      receipt.series = task
      if (!task.ok || task.status !== 'series-complete') throw Error('complete-series-not-accepted')
      const progress = task.data.series
      assert.equal(progress.episodeCount, 36); assert.equal(progress.catalogComplete, true)
      assert.deepEqual(progress.completedEpisodeNumbers, Array.from({ length: 36 }, (_, index) => index + 1))
      for (const key of ['pendingEpisodeNumbers', 'inProgressEpisodeNumbers', 'failedEpisodeNumbers', 'deniedEpisodeNumbers', 'unknownEpisodeNumbers', 'missingEpisodeNumbers']) assert.deepEqual(progress[key], [])
      const manifest = JSON.parse(await readFile(progress.manifestPath, 'utf8'))
      receipt.seriesFiles = []
      for (const entry of manifest.episodes) {
        assert.equal(entry.state, 'complete'); assert.equal(entry.media.fullDecodePassed, true)
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(entry.media.localPath)) hash.update(chunk)
        assert.equal(hash.digest('hex'), entry.media.sha256)
        assert.equal((await lstat(entry.media.localPath)).size, entry.media.bytes)
        receipt.seriesFiles.push({ episodeNo: entry.episodeNo, ...entry.media })
      }
      const beforeStatus = receipt.nativeMethods.length
      const status = await call('series_status', selection)
      assert.equal(status.status, 'series-complete'); assert.equal(receipt.nativeMethods.length, beforeStatus)
      const beforeResume = receipt.nativeMethods.filter(action => action === 'download_episode').length
      const resumed = await call('download_series', selection)
      assert.equal(resumed.status, 'series-complete')
      assert.equal(receipt.nativeMethods.filter(action => action === 'download_episode').length, beforeResume)
      receipt.fullSeriesAccepted = true; receipt.seriesStatusOffline = true; receipt.repeatMediaAcquisitions = 0
    }
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
    assert.equal(receipt.sshLaunches, transport.transport === 'local' ? 0 : 1)
    assert.equal(receipt.localLaunches, transport.transport === 'local' ? 1 : 0)
    if (!args.series) assert.equal(receipt.calls.length, args.download ? 5 : 4)
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
      const bridgeEntry = [...ctx.loader.entries()].find(row => row.options.name === 'shared-bridge')
      if (bridgeEntry?.fiber !== undefined) await bridgeEntry.fiber.dispose()
      await ctx.fiber.dispose()
      for (const facts of receipt.processes) {
        assert.ok(facts.exits.some(outcome => outcome.exitCode === 0 && outcome.signal === null))
        assert.ok(facts.rangeChecks.length > 0 && facts.rangeChecks.every(Boolean))
        if (facts.kind !== 'copy') assert.ok(facts.closedEvents.some(event =>
          ['control-close', 'control-eof', 'host-context-ended', 'hook-disposed', 'peer-ended', 'deadline', 'cancelled'].includes(event.status)
          && event.dispose && event.unload && event.detach && event.serverClosed))
      }
      receipt.cleanup = true
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
