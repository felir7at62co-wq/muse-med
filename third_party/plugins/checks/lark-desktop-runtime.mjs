/** Exercise compiled private staging modules through the Loader without real Feishu traffic. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import fsp from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { boot, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import Agents from '@deepseek-ai/dsh-agent'
import Projections from '@deepseek-ai/dsh-session-projection'
import Goals from '@deepseek-ai/dsh-goal'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import * as plugin from './lib/types/index.js'
import { internals } from './lib/types/runtime.js'
import { resolveConfig } from './lib/types/config.js'

const originalInternals = { ...internals }
const environmentKeys = ['DSH_HOME', 'DSH_SYNC_HOME']

/** The composition row this package's bundle patch inserts; the host names this plugin's settings section after it. */
const ROW_ID = 'feishu-channel'

/** Deployment-owned row values: a product ships the bridge inert and overrides these per deployment. */
const ROW_CONFIG = {
  enabled: false, autoRegistration: false, crossInstanceSync: false,
  provider: 'fixture', model: 'fixture',
  reactionFeedback: false, syncSlashCommands: false, tokenPressure: { enabled: false },
}

/**
 * Compose a real profile: a bundle layer inserts the rows, and the profile's own
 * patch layer stores what was saved for this row — the layer the settings
 * service persists into and reads a section back from. A patch row replaces the
 * whole config, so the stored layer is the deployment row with the saved values
 * on top: exactly the complete config the settings service writes back.
 * @param root - Temporary Harness home for one case.
 * @param saved - The values saved for this row.
 * @returns The profile context and the exact document text a boot must leave untouched.
 */
async function compose(root, saved) {
  const dir = join(root, 'profiles', 'lark-check')
  const bundle = join(dir, 'node_modules', 'lark-check-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(root, 'package.json'), '{"name":"lark-check-installation"}\n')
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'lark-check', dsh: { profile: { bundles: ['lark-check-bundle'] } } }))
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'lark-check-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'agents', name: 'cordis:agents' },
    { id: 'projections', name: 'cordis:projections' },
    { id: 'goals', name: 'cordis:goals' },
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: ROW_ID, name: 'cordis:lark', config: ROW_CONFIG },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const patchPath = join(dir, 'cordis.patch.yml')
  const document = `${JSON.stringify([{ id: ROW_ID, config: { ...ROW_CONFIG, ...saved } }], null, 2)}\n`
  await writeFile(patchPath, document)
  return {
    document,
    patchPath,
    profile: {
      name: 'lark-check', dir, patchPath, installAnchor: join(root, 'package.json'),
      cwd: root, home: root, startedBundles: ['lark-check-bundle'], overlays: [], telemetryDisabledEnv: undefined,
    },
  }
}

/**
 * Boot the composed profile and let the plugin's detached bootstrap settle.
 * @param profile - The profile context {@link compose} returned.
 * @returns The booted root context.
 */
async function start(profile) {
  const ctx = await boot('dsh lark check', join(profile.dir, 'cordis.yml'), readProfilePatches('dsh lark check', profile), (root) => {
    root.provide('profileContext', profile)
    Object.assign(root.loader.builtins, {
      agents: Agents, projections: Projections, goals: Goals,
      editor: ConfigEditor, settings: Settings, lark: plugin,
    })
  })
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  // `apply` runs its bootstrap detached: read the settings section the host named
  // for this row, then start or skip the channel. Ten turns cover both.
  for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 5))
  return ctx
}

/** The live Loader row for this plugin, resolved and mounted. */
function rowOf(ctx) {
  const row = [...ctx.loader.entries()].find(entry => entry.options.id === ROW_ID)
  assert.ok(row?.fiber, 'the composition mounted the bridge row')
  return row
}

for (const [label, saved, expectedConnections] of [
  ['disabled settings stay available without side effects', {}, 0],
  ['enabled without credentials never registers an app automatically', { enabled: true }, 0],
  ['saved opt-in and credentials start chat only and dispose its channel', { enabled: true, appId: 'fixture-app', appSecret: 'fixture-secret' }, 1],
]) {
  test(label, async () => {
    const root = await mkdtemp(join(process.cwd(), '.muse-lark-runtime-'))
    const previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]))
    const calls = { connect: 0, disconnect: 0, register: 0, sockets: 0, syncReads: 0, network: 0 }
    const handlers = new Map()
    const sent = []
    const notes = []
    const oldHome = join(root, 'unrelated-sync-home')
    const originalRead = fsp.readFile
    const readSpy = mock.method(fsp, 'readFile', (...args) => {
      if (String(args[0]).includes('unrelated-sync-home')) calls.syncReads++
      return originalRead(...args)
    })
    const socketSpy = mock.method(http, 'createServer', () => {
      calls.sockets++
      throw new Error('Test forbids the cross-instance control server')
    })
    const fetchSpy = mock.method(globalThis, 'fetch', async () => {
      calls.network++
      throw new Error('Test forbids external network access')
    })
    let ctx
    try {
      process.env.DSH_HOME = root
      process.env.DSH_SYNC_HOME = oldHome
      await mkdir(join(oldHome, 'dsh-lark-bridge'), { recursive: true })
      await writeFile(join(oldHome, 'dsh-lark-bridge', 'settings.json'), JSON.stringify({ appId: 'unrelated-app', appSecret: 'unrelated-secret' }))
      await writeFile(join(oldHome, 'dsh-lark-bridge', 'device.json'), JSON.stringify({ retired: true, deviceId: 'unrelated-device' }))
      internals.notify = line => notes.push(line)
      internals.registerApp = async () => { calls.register++; throw new Error('Unexpected registration') }
      internals.createPort = config => {
        assert.equal(config.appId, 'fixture-app')
        assert.equal(config.appSecret, 'fixture-secret')
        return {
          connect: async () => { calls.connect++ },
          disconnect: async () => { calls.disconnect++ },
          on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name) },
          send: async (_chat, message) => { sent.push(message); return { messageId: 'fixture-message' } },
        }
      }
      const { document, patchPath, profile } = await compose(root, saved)
      ctx = await start(profile)
      // The real settings service names one namespace per active entry: this row is
      // its own section, and the values below are what an operator's save stored.
      const section = ctx.get('settings').describe({ redactSecrets: true }).find(item => item.ns === ROW_ID)
      assert.ok(section, 'the real settings service exposes this row as a configuration section')
      assert.equal(section.applies, 'live')
      assert.equal(section.value.appId, saved.appId)
      assert.equal(section.user.appId, saved.appId)
      assert.equal(
        section.secrets.some(secret => secret.path.join('.') === 'appSecret' && secret.set),
        saved.appSecret !== undefined,
        'the section reports whether a stored secret is set',
      )
      const row = rowOf(ctx)
      assert.equal(row.fiber.config.enabled, saved.enabled ?? false)
      assert.equal(row.fiber.config.crossInstanceSync, false)
      assert.equal(calls.syncReads, 0, 'disabled cross-instance sync must not read another home')
      assert.equal(calls.connect, expectedConnections)
      if (expectedConnections) {
        assert.ok(handlers.has('message'))
        handlers.get('message')({ chatId: 'fixture-chat', chatType: 'p2p', senderId: 'fixture-sender', messageId: 'fixture-inbound', content: 'hello' })
        await new Promise(resolve => setImmediate(resolve))
        // The real Agent registry deliberately has no model factory; reaching it proves this inbound request
        // was not intercepted by a retired device or an unrelated machine's arbitration settings.
        assert.ok(notes.some(line => /factory/u.test(line)), notes.join('\n'))
        assert.ok(!sent.some(message => /退位|活跃设备/u.test(message.markdown ?? '')))
      }
      assert.equal(calls.register, 0)
      assert.equal(calls.sockets, 0)
      assert.equal(calls.network, 0)
      await ctx.fiber.dispose()
      assert.equal(calls.disconnect, expectedConnections)
      assert.equal(handlers.size, 0)
      assert.equal(ctx.get('settings'), undefined)
      assert.equal(await readFile(patchPath, 'utf8'), document, 'a boot without a completed save leaves the profile document untouched')
    } finally {
      await ctx?.fiber.dispose()
      Object.assign(internals, originalInternals)
      readSpy.mock.restore()
      socketSpy.mock.restore()
      fetchSpy.mock.restore()
      for (const key of environmentKeys) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('a scanned app persists through this row settings namespace and starts the channel', async () => {
  const root = await mkdtemp(join(process.cwd(), '.muse-lark-runtime-'))
  const previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]))
  const calls = { connect: 0, disconnect: 0, register: 0, network: 0 }
  const handlers = new Map()
  const notes = []
  const originalRead = fsp.readFile
  const readSpy = mock.method(fsp, 'readFile', (...args) => originalRead(...args))
  const fetchSpy = mock.method(globalThis, 'fetch', async () => {
    calls.network++
    throw new Error('Test forbids external network access')
  })
  let ctx
  try {
    process.env.DSH_HOME = root
    process.env.DSH_SYNC_HOME = join(root, 'unrelated-sync-home')
    internals.notify = line => notes.push(line)
    internals.registerApp = async () => {
      calls.register++
      return { client_id: 'scanned-app', client_secret: 'scanned-secret', user_info: { open_id: 'ou_fixture' } }
    }
    internals.createPort = config => {
      assert.equal(config.appId, 'scanned-app')
      assert.equal(config.appSecret, 'scanned-secret')
      return {
        connect: async () => { calls.connect++ },
        disconnect: async () => { calls.disconnect++ },
        on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name) },
        send: async () => ({ messageId: 'fixture-message' }),
      }
    }
    const { patchPath, profile } = await compose(root, { enabled: true, autoRegistration: true })
    ctx = await start(profile)
    assert.equal(calls.register, 1, 'the absent credentials started the QR registration flow')
    assert.equal(calls.connect, 1, 'the scanned credentials started the channel')
    assert.equal(calls.network, 0)
    // The save went through the settings service into this row's section: the profile
    // document now stores the scanned pair, and the running entry reads it live.
    const stored = await readFile(patchPath, 'utf8')
    assert.match(stored, /scanned-app/u)
    assert.match(stored, /scanned-secret/u)
    assert.match(stored, /ou_fixture/u)
    const row = rowOf(ctx)
    assert.equal(row.fiber.config.appId.get(), 'scanned-app')
    assert.equal(row.fiber.config.appSecret.get(), 'scanned-secret')
    const section = ctx.get('settings').describe({ redactSecrets: true }).find(item => item.ns === ROW_ID)
    assert.equal(section.value.appId, 'scanned-app')
    assert.ok(section.secrets.some(secret => secret.path.join('.') === 'appSecret' && secret.set))
    assert.ok(notes.some(line => line.includes('凭证已写入用户设置')), notes.join('\n'))
  } finally {
    await ctx?.fiber.dispose()
    Object.assign(internals, originalInternals)
    readSpy.mock.restore()
    fetchSpy.mock.restore()
    for (const key of environmentKeys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('omitted flags preserve upstream activation defaults and the credential secret role', () => {
  const resolved = resolveConfig({})
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.autoRegistration, true)
  assert.equal(resolved.crossInstanceSync, true)
  assert.equal(plugin.Config.dict.appSecret.meta.role, 'secret')
  // The settings service persists live fields only: onboarding can only write the
  // credential pair and its scan record back when the schema marks them volatile.
  for (const field of ['appId', 'appSecret', 'registeredBy']) {
    assert.equal(plugin.Config.dict[field].meta.volatile, true, `${field} must stay writable through the settings service`)
  }
})
