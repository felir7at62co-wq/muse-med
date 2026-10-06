import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { MuseDesktopTunnelOptions } from '../src/desktop-bridge.ts'
import { MuseDesktopBridge } from '../src/desktop-bridge.ts'
import { MuseDesktopRemote } from '../src/desktop-remote.ts'
import { writeMuseSession } from '../src/session.ts'

const homes: string[] = []
const owners: MuseDesktopRemote[] = []
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>()
  return { ...os, hostname: vi.fn(os.hostname) }
})
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
  vi.mocked(hostname).mockReset()
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'muse-desktop-owner-'))
  homes.push(home)
  const calls: MuseDesktopTunnelOptions[] = []
  const stopped: number[] = []
  const options = {
    baseUrl: 'https://muse.example', sessionFile: join(home, 'session.json'), deviceFile: join(home, 'device.json'),
    chunkBytes: 32768, ackTimeoutMs: 5000, reconnectMaxIntervalMs: 60_000,
    localAuthorization: async () => ({ port: 32145, cookie: 'host=private-local' }),
    bridge: { createTunnel: (settings: MuseDesktopTunnelOptions) => {
      const index = calls.push(settings) - 1
      return { start: async () => {}, stop: async () => {stopped.push(index)} }
    } },
  }
  const owner = new MuseDesktopRemote(options)
  owners.push(owner)
  const login = (username: string) => writeMuseSession(options.sessionFile,
    { baseUrl: options.baseUrl, username, cookie: `__Host-muse=${username}` })
  return { home, options, owner, calls, stopped, login }
}

it('connects a restored account once and keeps its installation identity across restarts', async () => {
  const f = await fixture()
  await f.owner.refresh()
  expect(f.calls).toHaveLength(0)
  await f.login('alice')
  await f.owner.refresh()
  await f.owner.refresh()
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]).toMatchObject({ serverUrl: 'wss://muse.example/api/desktop/connect',
    headers: { cookie: '__Host-muse=alice', origin: 'https://muse.example' }, localPort: 32145, loopbackCookie: 'host=private-local' })
  expect(f.calls[0]?.serverUrl).not.toContain('alice')
  expect(f.calls[0]?.deviceName).toBe(hostname().replace(/[\x00-\x1f\x7f]/gu, '').trim().slice(0, 80))
  expect(f.calls[0]?.platform).toBe(process.platform)
  const disk = await readFile(f.options.deviceFile, 'utf8')
  expect(disk).not.toContain('private-local')
  await f.owner.dispose()
  const next = new MuseDesktopRemote(f.options)
  owners.push(next)
  await next.refresh()
  expect(f.calls[1]?.deviceId).toEqual(f.calls[0]?.deviceId)
})

it('stops the old account before connecting a replacement and pauses a logout revision', async () => {
  const f = await fixture()
  await f.login('alice')
  await f.owner.refresh()
  await f.owner.pause()
  await f.owner.refresh()
  expect(f.stopped).toEqual([0])
  expect(f.calls).toHaveLength(1)
  await f.login('bob')
  await f.owner.refresh()
  expect(f.calls).toHaveLength(2)
  expect(f.calls[1]?.headers.cookie).toBe('__Host-muse=bob')
  await rm(f.options.sessionFile)
  await f.owner.refresh()
  expect(f.stopped).toEqual([0, 1])
})

it('does not connect an account removed while obtaining local Host authorization', async () => {
  const f = await fixture()
  let entered!: () => void
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {entered = resolve})
  const gate = new Promise<void>((resolve) => {release = resolve})
  const owner = new MuseDesktopRemote({ ...f.options, localAuthorization: async () => {
    entered()
    await gate
    return { port: 32145, cookie: 'host=private-local' }
  } })
  owners.push(owner)
  await f.login('alice')
  const refreshing = owner.refresh()
  await waiting
  await rm(f.options.sessionFile)
  release()
  await refreshing
  expect(f.calls).toHaveLength(0)
})

it('exposes a concrete desktop provider through its owning Cordis context', async () => {
  const context = new Context()
  const start = vi.fn(async () => {}), stop = vi.fn(async () => {})
  class Provider extends MuseDesktopBridge {
    createTunnel(_options: MuseDesktopTunnelOptions) { return { start, stop } }
  }
  try {
    await context.plugin(Provider)
    expect(context.get('museDesktopBridge')).toBeInstanceOf(Provider)
  } finally { await context.fiber.dispose() }
  expect(context.get('museDesktopBridge')).toBeUndefined()
})

it('ignores stale connection notifications while forwarding the current account connection', async () => {
  const f = await fixture(), onState = vi.fn()
  const owner = new MuseDesktopRemote({ ...f.options, onState })
  owners.push(owner)
  await f.login('alice'); await owner.refresh()
  f.calls[0]?.onState('online')
  expect(onState).toHaveBeenLastCalledWith('online')
  await f.login('bob'); await owner.refresh()
  f.calls[0]?.onState('offline')
  expect(onState).toHaveBeenCalledTimes(1)
  f.calls[1]?.onState('connecting')
  expect(onState).toHaveBeenLastCalledWith('connecting')
  await owner.dispose()
  f.calls[1]?.onState('offline')
  expect(onState).toHaveBeenCalledTimes(2)
  await owner.refresh()
  expect(f.calls).toHaveLength(2)
})

it('accepts optional state observers and recovers serialization after an invalid installation identity', async () => {
  const f = await fixture()
  await f.login('alice')
  await writeFile(f.options.deviceFile, '{"version":2,"id":"invalid"}')
  await expect(f.owner.refresh()).rejects.toThrow('invalid desktop identity')
  await rm(f.options.deviceFile)
  await f.owner.refresh()
  f.calls[0]?.onState('online')
  expect(f.calls).toHaveLength(1)
})

it.each(['null', '[]', '"identity"', '{"version":1,"id":7}', '{"version":1,"id":"wrong"}'])(
  'refuses malformed persisted desktop identity %s', async (text) => {
    const f = await fixture()
    await f.login('alice')
    await writeFile(f.options.deviceFile, text)
    await expect(f.owner.refresh()).rejects.toThrow('invalid desktop identity')
    expect(f.calls).toHaveLength(0)
  },
)

it('propagates an unreadable desktop identity instead of replacing it with a new installation', async () => {
  const f = await fixture()
  await f.login('alice')
  await mkdir(f.options.deviceFile)
  await expect(f.owner.refresh()).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
})

it('does not publish a connection after disposal while local authorization is pending', async () => {
  const f = await fixture()
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const owner = new MuseDesktopRemote({ ...f.options, localAuthorization: async () => {
    entered(); await gate; return { port: 32145, cookie: 'host=private-local' }
  } })
  owners.push(owner)
  await f.login('alice')
  const refreshing = owner.refresh(); await waiting
  const disposing = owner.dispose()
  release(); await refreshing; await disposing
  expect(f.calls).toHaveLength(0)
})

it('keeps sign-in usable when a provider start rejects and stops that owned tunnel on disposal', async () => {
  const f = await fixture(), stop = vi.fn(async () => {})
  const owner = new MuseDesktopRemote({ ...f.options, bridge: { createTunnel: () => ({
    start: async () => { throw new Error('network unavailable') }, stop,
  }) } })
  owners.push(owner)
  await f.login('alice'); await owner.refresh()
  await owner.dispose()
  expect(stop).toHaveBeenCalledTimes(1)
})

it('uses a retained identity as the display name on unnamed hosts and maps an unsupported platform safely', async () => {
  const f = await fixture()
  await f.login('alice')
  vi.mocked(hostname).mockReturnValue('\0\t')
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (!descriptor) throw new Error('Missing process.platform descriptor')
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'aix' })
    await f.owner.refresh()
  } finally { Object.defineProperty(process, 'platform', descriptor) }
  expect(f.calls[0]?.deviceName).toBe(`Muse · ${f.calls[0]?.deviceId.slice(0, 8)}`)
  expect(f.calls[0]?.platform).toBe('unknown')
})

it('uses a ws relay when the configured account gateway is loopback HTTP', async () => {
  const f = await fixture(), baseUrl = 'http://127.0.0.1:19388'
  const owner = new MuseDesktopRemote({ ...f.options, baseUrl })
  owners.push(owner)
  await writeMuseSession(f.options.sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=alice' })
  await owner.refresh()
  expect(f.calls[0]?.serverUrl).toBe('ws://127.0.0.1:19388/api/desktop/connect')
})
