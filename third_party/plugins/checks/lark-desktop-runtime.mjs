/** Exercise compiled private staging modules through the Loader without real Feishu traffic. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import fsp from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mock, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import Projections from '@deepseek-ai/dsh-session-projection'
import Goals from '@deepseek-ai/dsh-goal'
import Settings from '@deepseek-ai/dsh-settings-file'
import * as plugin from './lib/types/index.js'
import { internals } from './lib/types/runtime.js'
import { resolveConfig } from './lib/types/config.js'

const originalInternals = { ...internals }
const environmentKeys = ['DSH_HOME', 'DSH_SYNC_HOME']

for (const [label, saved, expectedConnections] of [
  ['disabled settings stay available without side effects', {}, 0],
  ['enabled without credentials never registers an app automatically', { enabled: true }, 0],
  ['saved opt-in and credentials start chat only and dispose its channel', { enabled: true, appId: 'fixture-app', appSecret: 'fixture-secret' }, 1],
]) {
  test(label, async () => {
    const root = await mkdtemp(join(process.cwd(), '.muse-lark-runtime-'))
    const previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]))
    const ctx = new Context()
    const calls = { connect: 0, disconnect: 0, register: 0, sockets: 0, syncReads: 0, network: 0 }
    const handlers = new Map()
    const sent = []
    const notes = []
    const oldHome = join(root, 'unrelated-sync-home')
    const settingsPath = join(root, 'settings.json')
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
    try {
      process.env.DSH_HOME = root
      process.env.DSH_SYNC_HOME = oldHome
      await mkdir(join(oldHome, 'dsh-lark-bridge'), { recursive: true })
      await writeFile(join(oldHome, 'dsh-lark-bridge', 'settings.json'), JSON.stringify({ appId: 'unrelated-app', appSecret: 'unrelated-secret' }))
      await writeFile(join(oldHome, 'dsh-lark-bridge', 'device.json'), JSON.stringify({ retired: true, deviceId: 'unrelated-device' }))
      await writeFile(settingsPath, JSON.stringify({ 'dsh-lark-bridge': saved }))
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
      const configuration = join(root, 'cordis.yml')
      await writeFile(configuration, JSON.stringify([
        { id: 'agents', name: 'test:agents' },
        { id: 'projections', name: 'test:projections' },
        { id: 'goals', name: 'test:goals' },
        { id: 'settings', name: 'test:settings', config: { path: settingsPath, watch: false } },
        { id: 'lark', name: 'test:lark', config: {
          enabled: false, autoRegistration: false, crossInstanceSync: false,
          provider: 'fixture', model: 'fixture',
          reactionFeedback: false, syncSlashCommands: false, tokenPressure: { enabled: false },
        } },
      ]))
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      const modules = new Map([
        ['test:agents', Agents], ['test:projections', Projections], ['test:goals', Goals],
        ['test:settings', Settings], ['test:lark', plugin],
      ])
      ctx.loader.internal = { version: 'v2', async import(name) {
        if (!modules.has(name)) throw new Error(`Unexpected module ${name}`)
        return modules.get(name)
      } }
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configuration).href } })
      await ctx.loader.await()
      for (const entry of ctx.loader.entries()) await entry.fiber?.await()
      await new Promise(resolve => setImmediate(resolve))
      const section = ctx.get('settings').describe().find(item => item.ns === 'dsh-lark-bridge')
      assert.ok(section, 'the real settings provider exposes the configuration section')
      assert.equal(calls.syncReads, 0, 'disabled cross-instance sync must not read another home')
      assert.equal(section.applies, 'restart')
      assert.equal(section.value.enabled, saved.enabled ?? false)
      assert.equal(section.value.crossInstanceSync, false)
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
      assert.equal(calls.syncReads, 0)
      assert.equal(calls.network, 0)
      await ctx.fiber.dispose()
      assert.equal(calls.disconnect, expectedConnections)
      assert.equal(handlers.size, 0)
      assert.equal(ctx.get('settings'), undefined)
      assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { 'dsh-lark-bridge': saved })
    } finally {
      await ctx.fiber.dispose()
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

test('omitted flags preserve upstream activation defaults and the credential secret role', () => {
  const resolved = resolveConfig({})
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.autoRegistration, true)
  assert.equal(resolved.crossInstanceSync, true)
  assert.equal(plugin.Config.dict.appSecret.meta.role, 'secret')
})
