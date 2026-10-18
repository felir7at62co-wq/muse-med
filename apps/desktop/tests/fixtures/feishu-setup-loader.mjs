/** Real Loader/Settings and Muse Config/mount; native Feishu transport activation is tested in the built artifact. */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FiberState } from '@deepseek-ai/cordis'
import { boot, composeEntries, initProfile, loadOverlayPatches, PluginPackages, readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import ClientModules from '@deepseek-ai/dsh-client-modules'
import * as FeishuSettings from '@deepseek-ai/dsh-feishu-settings'
import { applyBridgeDesktopCompatibility } from '../../../../third_party/plugins/compatibility/bridge-desktop.mjs'
import { feishuGateLayer, migrateFeishuProfileName } from '../../../desktop-host/src/feishu-gate.ts'
import { bundledBridgeModules, verifyBundledImClient } from '../../../desktop-host/src/bundled-bridge.ts'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const home = realpathSync(mkdtempSync(join(tmpdir(), 'muse-feishu-loader-')))
const scenario = process.argv[2]
const nativeArtifact = process.argv[3]
const runtime = join(home, 'runtime')
const bridgeRoot = join(home, 'bridge')
const feishuRoot = join(home, 'native-feishu')
const runtimeBridgeLink = join(runtime, 'node_modules/@wenbin_wb/dsh-bridge')
const runtimeFeishuLink = join(runtime, 'node_modules/@xmanrui/dsh-im')
const dependencyLink = join(bridgeRoot, 'node_modules')
let dependencyLinked = false
let runtimeBridgeLinked = false
let runtimeFeishuLinked = false
let ctx
let networkCalls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = () => {
  networkCalls++
  throw new Error('Unexpected Feishu network call')
}
try {
  cpSync(join(root, 'third_party/plugins/dsh-bridge'), bridgeRoot, { recursive: true })
  applyBridgeDesktopCompatibility(bridgeRoot)
  symlinkSync(join(root, 'node_modules'), dependencyLink, process.platform === 'win32' ? 'junction' : 'dir')
  dependencyLinked = true
  if (nativeArtifact !== undefined) {
    cpSync(nativeArtifact, feishuRoot, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(feishuRoot, 'package.json'), 'utf8'))
    for (const name of Object.keys(manifest.dependencies)) {
      const destination = join(feishuRoot, 'node_modules', name)
      mkdirSync(dirname(destination), { recursive: true })
      symlinkSync(join(root, 'third_party/plugins/toolchain/node_modules', name), destination,
        process.platform === 'win32' ? 'junction' : 'dir')
    }
  } else {
    mkdirSync(join(feishuRoot, 'lib'), { recursive: true })
    writeFileSync(join(feishuRoot, 'package.json'), JSON.stringify({
      name: '@xmanrui/dsh-im', version: '5.1.0', type: 'module',
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } },
    }))
    // No agent services are mounted: upstream activation must remain dormant while credentials are edited.
    writeFileSync(join(feishuRoot, 'lib/index.js'), `import { Config, name, mountMuseFeishu } from ${JSON.stringify(pathToFileURL(join(root, 'third_party/plugins/compatibility/muse-feishu-runtime.mjs')).href)}\nexport { Config, name }\nexport function apply(ctx, config) { return mountMuseFeishu(ctx, config, {}, {}) }\n`)
    writeFileSync(join(feishuRoot, 'lib/client.js'), 'window.__ModuleLoader__.load({ id: "@xmanrui/dsh-im", factory: () => ({}) })\n')
  }
  const bridge = await import(pathToFileURL(join(feishuRoot, 'lib/index.js')).href)
  if (scenario === 'profile-shadow') {
    mkdirSync(dirname(runtimeBridgeLink), { recursive: true })
    symlinkSync(bridgeRoot, runtimeBridgeLink, process.platform === 'win32' ? 'junction' : 'dir')
    runtimeBridgeLinked = true
    mkdirSync(dirname(runtimeFeishuLink), { recursive: true })
    symlinkSync(feishuRoot, runtimeFeishuLink, process.platform === 'win32' ? 'junction' : 'dir')
    runtimeFeishuLinked = true
  }
  const dir = join(home, 'profiles/test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules/test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  const rows = [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'feishu', name: 'cordis:feishu' },
    { id: 'other-row', name: 'cordis:other', config: { enabled: true, appId: 'other' } },
  ]
  if (scenario !== 'other-rows') rows.push({ id: 'feishu-channel', name: 'cordis:bridge', config: { enabled: false } })
  if (scenario === 'profile-shadow') {
    rows.find(row => row.id === 'feishu-channel').name = '@xmanrui/dsh-im'
    rows.push({ id: 'muse-desktop-bridge', name: '@wenbin_wb/dsh-bridge/remote' },
      { id: 'external-plugin', name: 'synthetic-external-plugin' })
    const manifestPath = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies: {
      ...manifest.dependencies, '@wenbin_wb/dsh-bridge': '2.14.2', '@xmanrui/dsh-im': '5.1.0', 'synthetic-external-plugin': '1.0.0',
    } }))
    const upstream = join(dir, 'node_modules/@wenbin_wb/dsh-bridge')
    mkdirSync(upstream, { recursive: true })
    writeFileSync(join(upstream, 'package.json'), JSON.stringify({
      name: '@wenbin_wb/dsh-bridge', version: '2.14.2', type: 'module', exports: { '.': './index.js' },
      peerDependencies: { '@deepseek-ai/dsh-agent': '^999.0.0' },
    }))
    writeFileSync(join(upstream, 'index.js'), 'throw new Error("profile upstream bridge must not activate")\n')
    const shadowProfile = join(home, 'shadow-native-im')
    const shadowIm = join(shadowProfile, 'node_modules/@xmanrui/dsh-im')
    mkdirSync(shadowIm, { recursive: true })
    writeFileSync(join(shadowProfile, 'package.json'), JSON.stringify({ dependencies: { '@xmanrui/dsh-im': '999.0.0' } }))
    writeFileSync(join(shadowIm, 'package.json'), JSON.stringify({
      name: '@xmanrui/dsh-im', version: '999.0.0', type: 'module',
      exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } },
    }))
    writeFileSync(join(shadowIm, 'index.js'), 'throw new Error("profile IM must not activate")\n')
    writeFileSync(join(shadowIm, 'client.js'), 'throw new Error("profile IM client must not load")\n')
    assert.throws(() => verifyBundledImClient(runtime, shadowProfile), /conflicts with the bundled IM package/)
    const nativeLink = join(dir, 'node_modules/@xmanrui/dsh-im')
    mkdirSync(dirname(nativeLink), { recursive: true })
    symlinkSync(feishuRoot, nativeLink, process.platform === 'win32' ? 'junction' : 'dir')
    verifyBundledImClient(runtime, dir)
    const external = join(dir, 'node_modules/synthetic-external-plugin')
    mkdirSync(external, { recursive: true })
    writeFileSync(join(external, 'package.json'), JSON.stringify({ name: 'synthetic-external-plugin', version: '1.0.0', type: 'module', exports: './index.js' }))
    writeFileSync(join(external, 'index.js'), 'export const name = "synthetic-external-plugin"\nexport function apply(ctx) { ctx.provide("externalMarker", "profile") }\n')
  }
  const defaults = loadOverlayPatches('muse-feishu-loader', join(root, 'apps/desktop-host/config/defaults.cordis.patch.yml'))
    .filter(patch => patch.id === 'feishu-channel' && scenario !== 'other-rows')
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }, ...defaults]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  if (scenario === 'legacy') writeFileSync(profile.patchPath, JSON.stringify([
    { id: 'feishu-channel', config: { enabled: true, appId: 'cli_legacy', appSecret: 'synthetic-legacy-secret',
      registeredBy: 'ou_legacy', allowFrom: ['oc_original_group', 'ou_legacy'], activeSessionId: 'original-session' } },
  ]))
  if (scenario === 'expressions') writeFileSync(profile.patchPath, JSON.stringify([
    { id: 'feishu', config: { enabled: true } },
    { id: 'feishu-channel', config: {
      appId: { __jsExpr: "'cli_expression'" }, appSecret: { __jsExpr: "'synthetic-expression-secret'" },
    } },
  ]))
  if (scenario === 'profile-shadow') writeFileSync(profile.patchPath, JSON.stringify([
    { id: 'feishu-channel', name: '@wenbin_wb/dsh-bridge', config: { enabled: false, requireMention: true } },
  ]))
  const start = async () => {
    await migrateFeishuProfileName(dir)
    const patches = readProfilePatches('muse-feishu-loader', { ...profile, overlays: [] })
    const product = loadOverlayPatches('muse-feishu-loader', join(root, 'apps/desktop-host/config/desktop.cordis.patch.yml'))
      .filter(patch => patch.id === 'feishu-channel' && scenario !== 'other-rows')
    const composed = composeEntries([patches, product])
    const moduleOverrides = scenario === 'profile-shadow' ? bundledBridgeModules(runtime)
      : { '@xmanrui/dsh-im': pathToFileURL(join(feishuRoot, 'lib/index.js')).href }
    const current = { ...profile, overlays: [...product, ...feishuGateLayer(composed)] }
    ctx = await boot('muse-feishu-loader', join(dir, 'cordis.yml'), readProfilePatches('muse-feishu-loader', current), async host => {
      host.provide('profileContext', current)
      host.provide('appReady', { onReady: listener => { listener(); return () => {} } })
      Object.assign(host.loader.builtins, {
        editor: ConfigEditor, settings: Settings, feishu: FeishuSettings, bridge,
        other: { name: 'other', apply() {} },
      })
      if (scenario === 'profile-shadow') await host.plugin(PluginPackages, { resolution: {
        profilesDir: join(home, 'profiles'), profileDir: dir, linkedRoots: [],
        localPackageNames: ['@wenbin_wb/dsh-bridge', '@xmanrui/dsh-im', 'synthetic-external-plugin'],
        entries: [{ name: '@wenbin_wb/dsh-bridge', packageDir: bridgeRoot,
          version: '2.12.1', declarer: join(runtime, 'package.json'), scope: 'installation' },
        { name: '@xmanrui/dsh-im', packageDir: feishuRoot,
          version: '5.1.0', declarer: join(runtime, 'package.json'), scope: 'installation' }],
      } })
    }, undefined, moduleOverrides)
    await ctx.loader.await()
    if (scenario === 'profile-shadow' && nativeArtifact === undefined) await ctx.plugin(ClientModules)
  }
  const restart = async () => { await ctx.fiber.dispose(); ctx = undefined; await start() }
  const config = () => {
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'feishu-channel')
    assert.equal(entry?.fiber?.state, FiberState.ACTIVE)
    return entry.fiber.config
  }
  await start()
  if (scenario === 'lifecycle') {
    assert.equal(config().enabled, false)
    await ctx.feishuSetup.setCredentials({ appId: 'cli_personal', appSecret: 'synthetic-personal-secret' })
    assert.ok(readFileSync(profile.patchPath, 'utf8').includes('cli_personal'))
    assert.equal(config().appId.get(), 'cli_personal')
    assert.equal((await ctx.feishuSetup.setEnabled({ enabled: true })).row, 'restart-pending')
    assert.equal(config().enabled, false)
    await restart()
    assert.equal(config().enabled, true)
    assert.equal(config().appSecret.get(), 'synthetic-personal-secret')
    assert.equal((await ctx.feishuSetup.status()).row, 'active')
    await ctx.feishuSetup.setCredentials({ appId: 'cli_replaced', appSecret: 'synthetic-replaced-secret' })
    assert.equal(config().appSecret.get(), 'synthetic-replaced-secret')
    await ctx.feishuSetup.setEnabled({ enabled: false })
    assert.equal(config().enabled, true)
    await restart()
    assert.equal(config().enabled, false)
    assert.equal(config().appId.get(), 'cli_replaced')
    assert.equal(config().appSecret.get(), 'synthetic-replaced-secret')
    assert.deepEqual(await ctx.feishuSetup.status().then(value => [value.enabled, value.row, value.writable]), [false, 'disabled', true])
  } else if (scenario === 'late-credentials') {
    await assert.rejects(ctx.feishuSetup.setCredentials({ appId: 'cli_late', appSecret: '' }),
      error => error.code === 'feishu/secret-required')
    await ctx.feishuSetup.setEnabled({ enabled: true })
    await restart()
    assert.equal(config().enabled, false)
    assert.deepEqual(await ctx.feishuSetup.status().then(value => [value.enabled, value.row, value.credential, value.writable]),
      [true, 'restart-pending', 'none', true])
    await ctx.feishuSetup.setCredentials({ appId: 'cli_late', appSecret: 'synthetic-late-secret' })
    assert.equal(config().enabled, false)
    await ctx.feishuSetup.setCredentials({ appId: 'cli_late', appSecret: '' })
    assert.equal(config().appSecret.get(), 'synthetic-late-secret')
    await restart()
    assert.equal(config().enabled, true)
    assert.equal(config().appId.get(), 'cli_late')
    const forgotten = await ctx.feishuSetup.forget()
    assert.equal(forgotten.credential, 'none')
    assert.equal(config().appSecret.get(), '')
    await restart()
    assert.equal(config().enabled, false)
    assert.equal((await ctx.feishuSetup.status()).credential, 'none')
  } else if (scenario === 'legacy') {
    assert.equal(config().enabled, false)
    assert.equal(config().appId.get(), 'cli_legacy')
    assert.equal(config().appSecret.get(), 'synthetic-legacy-secret')
    assert.equal(config().registeredBy.get(), 'ou_legacy')
    assert.deepEqual(config().allowFrom.get(), ['oc_original_group', 'ou_legacy'])
    assert.equal(config().activeSessionId.get(), 'original-session')
    assert.equal(config().requireMention, true)
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'feishu-channel')
    const child = entry.fiber.ctx.plugin(() => {}, { enabled: true, appId: 'child', appSecret: 'synthetic-child' })
    await child.await()
    assert.equal(child.entry, entry)
    assert.equal(child.config.enabled, true)
  } else if (scenario === 'expressions') {
    assert.equal(config().enabled, true)
    assert.equal(config().appId.get(), 'cli_expression')
    assert.equal(config().appSecret.get(), 'synthetic-expression-secret')
  } else if (scenario === 'other-rows') {
    const other = [...ctx.loader.entries()].find(row => row.options.id === 'other-row')
    assert.deepEqual(other.fiber.config, { enabled: true, appId: 'other' })
    const child = other.fiber.ctx.plugin(() => {}, other.fiber.config)
    await child.await()
    assert.deepEqual(child.config, other.fiber.config)
    assert.equal((await ctx.feishuSetup.status()).row, 'unavailable')
  } else if (scenario === 'profile-shadow') {
    const channelName = [...ctx.loader.entries()].find(row => row.options.id === 'feishu-channel').options.name
    assert.equal(channelName, '@xmanrui/dsh-im')
    if (nativeArtifact === undefined) {
      const modules = ctx.get('clientModules')
      const entry = modules.graph().entries.find(entry => entry.id === '@xmanrui/dsh-im')
      assert.ok(entry, 'native IM must be present in the browser boot graph')
      assert.equal(realpathSync(modules.clientPath(entry.id)), realpathSync(join(feishuRoot, 'lib/client.js')))
      const response = await modules.fetchBundle(new Request(new URL(entry.url, 'http://127.0.0.1/')))
      assert.equal(response.status, 200)
      assert.match(await response.text(), /@xmanrui\/dsh-im/)
    }
    assert.equal(config().enabled, false)
    assert.equal(typeof ctx.get('museDesktopBridge')?.createTunnel, 'function')
    assert.equal(ctx.get('externalMarker'), 'profile')
    const remote = [...ctx.loader.entries()].find(row => row.options.id === 'muse-desktop-bridge')
    assert.equal(remote.fiber.state, FiberState.ACTIVE)
    assert.equal(remote.options.name, '@wenbin_wb/dsh-bridge/remote')
    const storedProfile = readFileSync(join(dir, 'package.json'), 'utf8')
    await ctx.feishuSetup.setCredentials({ appId: 'cli_retained', appSecret: 'synthetic-retained-secret' })
    assert.ok(readFileSync(profile.patchPath, 'utf8').includes('@xmanrui/dsh-im'))
    assert.ok(!readFileSync(profile.patchPath, 'utf8').includes('file:'))
    assert.equal(config().appId.get(), 'cli_retained')
    const previousRemote = ctx.get('museDesktopBridge')
    const channel = [...ctx.loader.entries()].find(row => row.options.id === 'feishu-channel')
    const warnings = await reconcileProfilePatches(ctx,
      [...readProfilePatches('muse-feishu-loader', ctx.profileContext),
        { id: 'muse-desktop-bridge', config: { revision: 2 } },
        { id: 'feishu-channel', config: { ...channel.options.config, requireMention: false } }], 'muse-feishu-loader')
    assert.deepEqual(warnings, [])
    assert.equal(config().appSecret.get(), 'synthetic-retained-secret')
    assert.equal(typeof ctx.get('museDesktopBridge')?.createTunnel, 'function')
    assert.notEqual(ctx.get('museDesktopBridge'), previousRemote)
    assert.equal(ctx.get('externalMarker'), 'profile')
    await restart()
    assert.equal(config().appId.get(), 'cli_retained')
    assert.equal(config().appSecret.get(), 'synthetic-retained-secret')
    assert.equal(config().enabled, false)
    assert.equal((await ctx.feishuSetup.status()).writable, true)
    assert.equal(typeof ctx.get('museDesktopBridge')?.createTunnel, 'function')
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), storedProfile)
  } else {
    throw new Error(`Unexpected scenario ${scenario}`)
  }
  assert.equal(networkCalls, 0)
  console.log(JSON.stringify({ scenario, passed: true, networkCalls }))
} finally {
  await ctx?.fiber.dispose()
  globalThis.fetch = originalFetch
  if (dependencyLinked) unlinkSync(dependencyLink)
  if (runtimeBridgeLinked) unlinkSync(runtimeBridgeLink)
  if (runtimeFeishuLinked) unlinkSync(runtimeFeishuLink)
  assert.equal(realpathSync(dirname(home)), realpathSync(tmpdir()))
  assert.ok(basename(home).startsWith('muse-feishu-loader-'))
  rmSync(home, { recursive: true, force: true })
}
