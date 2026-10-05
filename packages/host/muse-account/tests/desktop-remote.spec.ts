import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { MuseDesktopTunnelOptions } from '../src/desktop-bridge.ts'
import { MuseDesktopRemote } from '../src/desktop-remote.ts'
import { writeMuseSession } from '../src/session.ts'

const homes: string[] = []
const owners: MuseDesktopRemote[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
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
