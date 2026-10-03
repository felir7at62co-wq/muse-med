/** Source-mode fixture: real Loader, Settings, and reviewed bridge; no network services are supplied. */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FiberState } from '@deepseek-ai/cordis'
import { boot, composeEntries, initProfile, loadOverlayPatches, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import * as FeishuSettings from '@deepseek-ai/dsh-feishu-settings'
import { applyBridgeDesktopCompatibility } from '../../../../third_party/plugins/compatibility/bridge-desktop.mjs'
import { feishuGateLayer } from '../../../desktop-host/src/feishu-gate.ts'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const home = realpathSync(mkdtempSync(join(tmpdir(), 'muse-feishu-loader-')))
const bridgeRoot = join(home, 'bridge')
const dependencyLink = join(bridgeRoot, 'node_modules')
let dependencyLinked = false
const scenario = process.argv[2]
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
  const bridge = await import(pathToFileURL(join(bridgeRoot, 'lib/index.js')).href)
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
  const defaults = loadOverlayPatches('muse-feishu-loader', join(root, 'apps/desktop-host/config/defaults.cordis.patch.yml'))
    .filter(patch => patch.id === 'feishu-channel' && scenario !== 'other-rows')
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }, ...defaults]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  if (scenario === 'legacy') writeFileSync(profile.patchPath, JSON.stringify([
    { id: 'feishu-channel', config: { enabled: true, appId: 'cli_legacy', appSecret: 'synthetic-legacy-secret' } },
  ]))
  if (scenario === 'expressions') writeFileSync(profile.patchPath, JSON.stringify([
    { id: 'feishu', config: { enabled: true } },
    { id: 'feishu-channel', config: {
      appId: { __jsExpr: "'cli_expression'" }, appSecret: { __jsExpr: "'synthetic-expression-secret'" },
    } },
  ]))
  const start = async () => {
    const patches = readProfilePatches('muse-feishu-loader', { ...profile, overlays: [] })
    const product = loadOverlayPatches('muse-feishu-loader', join(root, 'apps/desktop-host/config/desktop.cordis.patch.yml'))
      .filter(patch => patch.id === 'feishu-channel' && scenario !== 'other-rows')
    const current = { ...profile, overlays: [...product, ...feishuGateLayer(composeEntries([patches, product]))] }
    ctx = await boot('muse-feishu-loader', join(dir, 'cordis.yml'), readProfilePatches('muse-feishu-loader', current), host => {
      host.provide('profileContext', current)
      host.provide('appReady', { onReady: listener => { listener(); return () => {} } })
      Object.assign(host.loader.builtins, {
        editor: ConfigEditor, settings: Settings, feishu: FeishuSettings, bridge,
        other: { name: 'other', apply() {} },
      })
    })
    await ctx.loader.await()
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
  } else {
    throw new Error(`Unexpected scenario ${scenario}`)
  }
  assert.equal(networkCalls, 0)
  console.log(JSON.stringify({ scenario, passed: true, networkCalls }))
} finally {
  await ctx?.fiber.dispose()
  globalThis.fetch = originalFetch
  if (dependencyLinked) unlinkSync(dependencyLink)
  assert.equal(realpathSync(dirname(home)), realpathSync(tmpdir()))
  assert.ok(basename(home).startsWith('muse-feishu-loader-'))
  rmSync(home, { recursive: true, force: true })
}
