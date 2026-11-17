/** Administrator policy validation before the private cloud route is registered. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { join } from 'node:path'
import * as CloudHost from '../src/cloud-host.ts'
import { MuseMarketCatalog } from '../src/server.ts'
import { directory, limits } from './fixtures.ts'

const secret = 'private-policy-test-secret-'.repeat(2)
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
async function fixture(host = '127.0.0.1') {
  const owner = await directory(), ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await owner.cleanup() } })
  await ctx.plugin(WebServer, { host, port: 0 }).await()
  const secretFile = join(owner.root, 'secret'), policyFile = join(owner.root, 'policy.json')
  const value = { root: join(owner.root, 'catalog'), secretFile, limits, maxReleases: 100, maxActiveUploads: 2,
    jsonRequestBytes: 16384, jsonResponseBytes: 1048576, catalogLimit: 100 }
  await writeFile(secretFile, secret, { mode: 0o600 })
  const policy = async (data: unknown = value) => { await writeFile(policyFile, JSON.stringify(data), { mode: 0o600 }) }
  await policy()
  return { ...owner, ctx, secretFile, policyFile, value, policy,
    apply: () => CloudHost.apply(ctx, { policyFile }), origin: `http://127.0.0.1:${ctx.webServer.port}` }
}

it('requires the explicit loopback carrier and an absolute administrator policy', async () => {
  const f = await fixture('::1')
  await expect(f.apply()).rejects.toMatchObject({ code: 'loopback-required' })
  const loopback = await fixture()
  await expect(CloudHost.apply(loopback.ctx, { policyFile: 'relative' })).rejects.toMatchObject({ code: 'invalid-policy' })
})

it.each(['not-file', 'oversized', 'bad-record', 'wrong-root', 'wrong-limit-count', 'out-of-range'] as const)(
  'refuses administrator policy %s before opening the catalog', async (mode) => {
    const f = await fixture()
    if (mode === 'not-file') {
      const path = join(f.root, 'policy-directory'); await mkdir(path)
      await expect(CloudHost.apply(f.ctx, { policyFile: path })).rejects.toMatchObject({ code: 'unsafe-policy' }); return
    }
    if (mode === 'oversized') await writeFile(f.policyFile, ' '.repeat(65537))
    else await f.policy(mode === 'bad-record' ? {} : mode === 'wrong-root' ? { ...f.value, root: 'relative' }
      : mode === 'wrong-limit-count' ? { ...f.value, limits: {} } : { ...f.value, maxReleases: 0 })
    await expect(f.apply()).rejects.toMatchObject({ code: mode === 'oversized' ? 'unsafe-policy' : 'invalid-policy' })
  },
)

it.each(['not-file', 'oversized', 'invalid'] as const)('refuses an unsafe or malformed secret: %s', async (mode) => {
  const f = await fixture()
  if (mode === 'not-file') { await f.policy({ ...f.value, secretFile: f.root }) }
  else await writeFile(f.secretFile, mode === 'oversized' ? 'x'.repeat(1025) : 'short')
  await expect(f.apply()).rejects.toMatchObject({ code: mode === 'invalid' ? 'invalid-secret' : 'unsafe-secret' })
})

it.runIf(process.platform !== 'win32')('refuses group-writable policies and nonprivate secrets', async () => {
  const f = await fixture()
  await chmod(f.policyFile, 0o622)
  await expect(f.apply()).rejects.toMatchObject({ code: 'unsafe-policy' })
  await chmod(f.policyFile, 0o600); await chmod(f.secretFile, 0o644)
  await expect(f.apply()).rejects.toMatchObject({ code: 'unsafe-secret' })
})

it.each(['policy', 'secret'] as const)('rejects POSIX permission bits on the %s file', async (target) => {
  const f = await fixture(), descriptor = Object.getOwnPropertyDescriptor(process, 'platform'), lstat = files.lstat
  if (descriptor === undefined) throw Error('Missing platform descriptor')
  const inspect = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    const metadata = await lstat(...args)
    if (args[0] === f.policyFile || args[0] === f.secretFile) {
      const unsafe = args[0] === (target === 'policy' ? f.policyFile : f.secretFile)
      const permissions = unsafe ? 0o622 : 0o600
      metadata.mode = typeof metadata.mode === 'number'
        ? metadata.mode & ~0o777 | permissions
        : metadata.mode & ~0o777n | BigInt(permissions)
    }
    return metadata
  })
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
    await expect(f.apply()).rejects.toMatchObject({ code: target === 'policy' ? 'unsafe-policy' : 'unsafe-secret' })
  } finally { Object.defineProperty(process, 'platform', descriptor); inspect.mockRestore() }
})

it('does not write an admission error to a response the carrier already ended', async () => {
  const f = await fixture(), register = f.ctx.webServer.register.bind(f.ctx.webServer)
  const intercept = vi.spyOn(f.ctx.webServer, 'register').mockImplementation((route) => {
    if (!('handler' in route)) return register(route)
    return register({ ...route, handler: (request, response) => { response.end(); return route.handler(request, response) } })
  })
  try { await f.apply() } finally { intercept.mockRestore() }
  const response = await fetch(f.origin + '/api/market/v1/catalog')
  expect(response.status).toBe(200); expect(await response.text()).toBe('')
})

it('closes its opened catalog when the carrier refuses registration', async () => {
  const f = await fixture(), failure = Error('Carrier closed')
  const register = vi.spyOn(f.ctx.webServer, 'register').mockImplementationOnce(() => { throw failure })
  try { await expect(f.apply()).rejects.toBe(failure) } finally { register.mockRestore() }
  const store = await MuseMarketCatalog.open(f.value)
  try { expect(store.identity({ id: 'a'.repeat(16) as Parameters<typeof store.identity>[0]['id'], username: 'reader', admin: false }).publishers).toEqual([]) }
  finally { await store.close() }
})

it('rejects noncanonical base64 actor assertions without forwarding the gateway secret', async () => {
  const f = await fixture(); await f.apply()
  for (const actor of ['Zh', 'a'.repeat(1025)]) {
    const response = await fetch(f.origin + '/api/market/v1/me', { headers: {
      authorization: `Bearer ${secret}`, 'x-muse-market-actor': actor,
    } })
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid-actor' })
  }
  expect(await readFile(f.secretFile, 'utf8')).toBe(secret)
})
