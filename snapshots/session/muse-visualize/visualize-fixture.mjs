/** Real native visualization calls in the product's default short-drama preset. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { loadOverlayPatches, resolvePluginResource } from '@deepseek-ai/dsh-app-boot'
import { runPluginCommand } from '@deepseek-ai/dsh-plugin-manager/operations'
import { resolvePnpmEntrypoint } from '../../../scripts/pnpm-entrypoint.mjs'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const Discovery = await importSnapshotModule(new URL('../../../packages/core/tool-discovery/src/index.ts', import.meta.url),
  new URL('../../../packages/core/tool-discovery/lib/index.js', import.meta.url))

/** Loader identity for the native visualization conversation. */
export const name = 'snapshot-muse-visualize'
/** Product preset, real Skill catalog, tool and Session services. */
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'workingDirectory', 'skills', 'llm', 'agents', 'sessions', 'profileContext', 'pluginPackages']

/**
 * Stage the runtime under the private home and retain its real file writes and result metadata.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Headless context.
 * @returns {Promise<void>} Readiness after the real tool, preset and discovery are active.
 */
export async function apply(ctx) {
  const cwd = process.cwd()
  const currentEvents = new Map()
  ctx.on('session/event', (session, event) => {
    if (session.header.origin === 'subagent') return
    const events = currentEvents.get(session.id) ?? []
    assert.ok(events.length < 256, 'The bounded native visualization scenario must not grow extra turns')
    events.push(event)
    currentEvents.set(session.id, events)
  })
  let entry
  if (process.env.DSH_EXAMPLE_MODE === 'lib') {
    const repository = fileURLToPath(new URL('../../../', import.meta.url))
    const source = realpathSync(process.env.MUSE_VISUALIZE_PACKAGE ?? join(repository, '.artifacts/visualize-snapshot-artifact/package'))
    const artifact = dirname(source)
    const receipt = JSON.parse(await readFile(join(artifact, 'installation.json'), 'utf8'))
    const pins = JSON.parse(await readFile(join(repository, 'third_party/plugins/sources.json'), 'utf8'))
    const sourceReceipt = JSON.parse(await readFile(join(source, 'SOURCE.json'), 'utf8'))
    assert.deepEqual(sourceReceipt.upstream, pins['dsh-visualize'])
    assert.equal(receipt.toolchainLockSha256,
      createHash('sha256').update(await readFile(join(repository, 'third_party/plugins/toolchain/pnpm-lock.yaml'))).digest('hex'))
    assert.deepEqual(receipt.packages.map(pkg => pkg.name), ['@nagi-ovo/dsh-visualize', 'react', 'loose-envify', 'js-tokens'])
    const specs = []
    for (const pkg of receipt.packages) {
      assert.equal(pkg.file, pkg.file.replaceAll('\\', '/').split('/').at(-1))
      const path = join(artifact, pkg.file)
      assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), pkg.sha256)
      if (pkg.name === '@nagi-ovo/dsh-visualize' || pkg.name === 'react') specs.push('file:' + path)
    }
    const profile = ctx.profileContext
    const privateHome = realpathSync(join(cwd, '.dsh'))
    const profilePath = relative(privateHome, realpathSync(profile.dir))
    assert.ok(profilePath !== '..' && !profilePath.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(profilePath))
    const before = ctx.pluginPackages.resolution
    assert.ok(before)
    const pnpm = resolvePnpmEntrypoint(join(repository, 'node_modules/pnpm/package.json'))
    const operation = {
      profile: profile.name, dir: realpathSync.native(profile.dir), installAnchor: profile.installAnchor, cwd, home: profile.home,
    }
    const options = {
      command: process.execPath, args: [pnpm], execution: 'service', outputBytes: 16384,
      activateNewBundles: false,
    }
    const react = receipt.packages.find(pkg => pkg.name === 'react')
    const loose = receipt.packages.find(pkg => pkg.name === 'loose-envify')
    const tokens = receipt.packages.find(pkg => pkg.name === 'js-tokens')
    const overrides = {
      [`react@${react.version}>loose-envify`]: 'file:' + join(artifact, loose.file),
      [`loose-envify@${loose.version}>js-tokens`]: 'file:' + join(artifact, tokens.file),
    }
    const configured = await runPluginCommand(operation,
      ['config', 'set', '--location=project', '--json', 'overrides', JSON.stringify(overrides)], options)
    assert.equal(configured.exitCode, 0, configured.output)
    const configuration = parseYaml(await readFile(join(profile.dir, 'pnpm-workspace.yaml'), 'utf8'))
    assert.equal(configuration.nodeLinker, 'hoisted')
    assert.equal(configuration.autoInstallPeers, false)
    assert.deepEqual(configuration.overrides, overrides)
    const result = await runPluginCommand(operation,
      ['add', ...specs, '--offline', '--save-exact', '--config.fail-on-unknown-builds=true'], options)
    assert.equal(result.exitCode, 0, result.output)
    assert.equal(result.timedOut, undefined)
    const lock = parseYaml(await readFile(join(profile.dir, 'pnpm-lock.yaml'), 'utf8'))
    assert.equal(Object.keys(lock.packages).length, receipt.packages.length)
    for (const pkg of Object.values(lock.packages)) assert.ok(pkg.resolution.tarball.startsWith('file:'), 'Private installation must use only the audited local archives')
    const importers = Object.entries(lock.importers).filter(([path]) => {
      const candidate = resolve(operation.dir, path)
      return existsSync(candidate) && realpathSync.native(candidate) === operation.dir
    })
    assert.equal(importers.length, 1, JSON.stringify({ directory: operation.dir, native: realpathSync.native(profile.dir), importers: Object.keys(lock.importers) }))
    assert.deepEqual(Object.keys(importers[0][1].dependencies).sort(), ['@nagi-ovo/dsh-visualize', 'react'])
    for (const pkg of Object.values(importers[0][1].dependencies)) assert.ok(pkg.specifier.startsWith('file:'))
    await ctx.pluginPackages.refresh()
    entry = resolvePluginResource('@nagi-ovo/dsh-visualize', pathToFileURL(join(profile.dir, 'package.json')).href)
    const installed = ctx.pluginPackages.packageOf('@nagi-ovo/dsh-visualize', pathToFileURL(entry).href)
    assert.ok(installed)
    assert.equal(relative(operation.dir, realpathSync.native(installed.dir)), join('node_modules', '@nagi-ovo', 'dsh-visualize'))
    assert.deepEqual(JSON.parse(await readFile(join(installed.dir, 'SOURCE.json'), 'utf8')), sourceReceipt)
    assert.deepEqual(await readFile(entry), await readFile(join(source, 'lib/index.js')))
    const peers = Object.keys(installed.manifest.peerDependencies).filter(name => name !== 'react')
    assert.equal(peers.length, 8)
    for (const name of peers) {
      const host = before.entries.find(pkg => pkg.name === name && pkg.scope === 'installation')
      assert.ok(host, name)
      const peer = ctx.pluginPackages.packageOf(name, pathToFileURL(entry).href)
      assert.ok(peer, name)
      assert.equal(realpathSync(peer.dir), realpathSync(host.packageDir), name)
      const resolved = resolvePluginResource(name, pathToFileURL(entry).href)
      const hostResolved = resolvePluginResource(name, pathToFileURL(join(host.packageDir, 'package.json')).href)
      assert.equal(realpathSync(resolved), realpathSync(hostResolved), name)
      assert.equal(await import(pathToFileURL(resolved).href), await import(pathToFileURL(hostResolved).href), name)
    }
    for (const pkg of receipt.packages) {
      const installed = ctx.pluginPackages.packageOf(pkg.name, pathToFileURL(entry).href)
      assert.ok(installed, pkg.name)
      assert.equal(installed.version, pkg.version)
      const directory = join(operation.dir, 'node_modules', pkg.name)
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      assert.equal(manifest.name, pkg.name)
      assert.equal(manifest.version, pkg.version)
      assert.equal(realpathSync.native(directory), directory)
      const host = before.entries.find(entry => entry.name === pkg.name && entry.scope === 'installation')
      if (host !== undefined) {
        const supplied = ctx.pluginPackages.packageOf(pkg.name, pathToFileURL(host.declarer).href)
        assert.ok(supplied)
        assert.equal(realpathSync.native(supplied.dir), realpathSync.native(host.packageDir), pkg.name)
      }
      assert.equal(realpathSync.native(installed.dir), directory, pkg.name)
    }
  } else {
    const plugin = join(cwd, '.dsh', 'plugins', 'dsh-visualize')
    await mkdir(plugin, { recursive: true })
    const source = process.env.MUSE_VISUALIZE_PACKAGE
      ?? fileURLToPath(new URL('../../../third_party/plugins/dsh-visualize/', import.meta.url))
    for (const part of ['src', 'assets', 'package.json']) await cp(join(source, part), join(plugin, part), { recursive: true })
    if (process.env.MUSE_VISUALIZE_PACKAGE) await cp(join(source, 'lib'), join(plugin, 'lib'), { recursive: true })
    entry = join(plugin, process.env.MUSE_VISUALIZE_PACKAGE ? 'lib/index.js' : 'src/index.ts')
  }
  const visualize = await import(pathToFileURL(entry).href)
  await ctx.plugin(visualize, {}).await()
  await mountPreset(ctx, { presetId: 'short-drama', hidePlatformShellTools: true })
  const row = loadOverlayPatches('visualize-residency', fileURLToPath(new URL(
    '../../../apps/desktop-host/config/desktop.cordis.patch.yml', import.meta.url,
  ))).flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'tool-discovery')
  assert.ok(row)
  assert.ok(row.config.alwaysLoad.includes('visualize'))
  assert.ok(row.config.excludeFromSearch.includes('visualize'))
  await ctx.plugin(Discovery, Discovery.Config(row.config)).await()
  let requests = 0, skillRead = false, createRead = false, updateRead = false
  ctx.on('llm/stream', async function* (options, next) {
    assert.equal(options.provider, 'snapshot-visualize')
    assert.equal(options.model, 'local-fixture')
    assert.ok(options.tools.some(tool => tool.name === 'visualize'), 'Visualization must be available without search')
    assert.ok(options.tools.some(tool => tool.name === 'skill'))
    const agent = ctx.agents.get(options.sessionId)
    assert.ok(agent)
    assert.ok(ctx.agentPresets.inspectCompositions(agent.ctx).some(preset => preset.id === 'short-drama'))
    assert.ok(options.messages.some(message => message.role === 'system'
      && message.content.some(block => block.type === 'text' && block.text.includes('你是 muse-med 短剧编导 Agent'))))
    for (const message of options.messages) {
      if (message.role !== 'tool') continue
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (message.toolCallId === 'call_visualize_skill') {
        assert.ok(text.includes('<skill_content name="visualize">'))
        assert.ok(text.includes('dshViz'))
        skillRead = true
      }
      if (message.toolCallId === 'call_visualize_create') { assert.ok(text.includes('Rendered')); createRead = true }
      if (message.toolCallId === 'call_visualize_update') { assert.ok(text.includes('Patched'), text); updateRead = true }
    }
    requests++
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = currentEvents.get(agent.session.id)
    assert.ok(events)
    const calls = events.filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => event.data.name), ['skill', 'visualize', 'visualize'])
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 3)
    for (const result of results) assert.equal(result.data.message.isError, false,
      result.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    const created = results[1].data.meta
    const updated = results[2].data.meta
    assert.equal(created.kind, 'visualize')
    assert.equal(updated.kind, 'visualize')
    assert.equal(created.path, updated.path)
    const homePath = ctx.get('dshHomePath')
    assert.equal(typeof homePath, 'function')
    const diskPath = updated.path.startsWith('~/') || (process.platform === 'win32' && updated.path.startsWith('~\\'))
      ? join(homedir(), updated.path.slice(2)) : updated.path
    const store = realpathSync(homePath('visualize', 'sessions', String(agent.session.id)))
    const storedPath = relative(store, realpathSync(diskPath))
    assert.ok(storedPath.length > 0 && storedPath !== '..' && !storedPath.startsWith('..' + sep) && !isAbsolute(storedPath),
      JSON.stringify({ path: created.path, home: homePath('visualize'), cwd, sessionId: agent.session.id }))
    assert.ok(created.fragment.includes('预算方案 V1'))
    assert.ok(updated.fragment.includes('预算方案 V2'))
    assert.ok(!updated.fragment.includes('预算方案 V1'))
    assert.equal(await readFile(diskPath, 'utf8'), updated.fragment)
    assert.ok(skillRead && createRead && updateRead)
    const header = events.find(event => event.type === 'request/header')
    assert.ok(header.data.header.tools.some(tool => tool.name === 'visualize'))
    await writeFile(join(cwd, 'visualization.html'), updated.fragment + '\n', { flag: 'wx' })
    await writeFile(join(cwd, 'visualize-proof.json'), JSON.stringify({
      preset: 'short-drama', requests, firstRequestIncludesVisualize: true, skillRead,
      calls: calls.map(event => event.data.name), discoveryCalls: 0,
      createdAndUpdated: true, stableCardPath: created.path === updated.path,
      persistedMeta: true, savedFileMatchesMeta: true, externalResources: false,
    }, null, 2) + '\n', { flag: 'wx' })
  })
  ctx.provide('snapshotVisualizeReady', { ready: true })
}
