import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MuseAccountController } from '../src/account.ts'
import { MuseGatewayError, type MuseAccountGateway } from '../src/gateway.ts'
import { readMuseSession, writeMuseSession } from '../src/session.ts'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function accountHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-muse-account-'))
  homes.push(home)
  return home
}

it('keeps the password out of the stored session and login result', async () => {
  const home = await accountHome()
  const file = join(home, 'session.json')
  const gateway: MuseAccountGateway = {
    signIn: async () => '__Host-muse=private-cookie',
    register: async () => { throw new Error('unexpected registration') },
    identity: async () => ({ username: 'writer', environment: 'development' }),
    signOut: async () => {},
  }
  const account = new MuseAccountController({ baseUrl: 'https://muse.example', sessionFile: file, gateway })

  const result = await account.login({ username: 'writer', password: 'secret-password', registerIfMissing: false })

  expect(result).toEqual({
    outcome: 'signed-in',
    status: { state: 'signed-in', username: 'writer', environment: 'development', verified: true },
  })
  expect(JSON.stringify(result)).not.toContain('secret-password')
  const stored = await readFile(file, 'utf8')
  expect(stored).toContain('__Host-muse=private-cookie')
  expect(stored).not.toContain('secret-password')
})

it('does not register after a rejected password unless the caller explicitly requests it', async () => {
  const home = await accountHome()
  let registrations = 0
  const gateway: MuseAccountGateway = {
    signIn: async () => { throw new MuseGatewayError('invalid-credentials') },
    register: async () => { registrations += 1; return '__Host-muse=new-cookie' },
    identity: async () => ({ username: 'writer' }),
    signOut: async () => {},
  }
  const account = new MuseAccountController({ baseUrl: 'https://muse.example', sessionFile: join(home, 'session.json'), gateway })

  await expect(account.login({ username: 'writer', password: 'wrong', registerIfMissing: false }))
    .rejects.toMatchObject({ code: 'invalid-credentials' })
  expect(registrations).toBe(0)

  const created = await account.login({ username: 'writer', password: 'chosen', registerIfMissing: true })
  expect(created.outcome).toBe('registered')
  expect(registrations).toBe(1)
})

it('does not remove a newer login when an older verification is rejected', async () => {
  const home = await accountHome()
  const file = join(home, 'session.json')
  await writeMuseSession(file, { baseUrl: 'https://muse.example', cookie: '__Host-muse=old', username: 'old' })
  let signalEntered!: () => void
  let finishCheck!: () => void
  const entered = new Promise<void>((resolve) => { signalEntered = resolve })
  const paused = new Promise<void>((resolve) => { finishCheck = resolve })
  const gateway: MuseAccountGateway = {
    signIn: async () => { throw new Error('unused') },
    register: async () => { throw new Error('unused') },
    identity: async () => { signalEntered(); await paused; throw new MuseGatewayError('invalid-credentials') },
    signOut: async () => {},
  }
  const account = new MuseAccountController({ baseUrl: 'https://muse.example', sessionFile: file, gateway })

  const verifying = account.status({ verify: true })
  await entered
  await writeMuseSession(file, { baseUrl: 'https://muse.example', cookie: '__Host-muse=new', username: 'new' })
  finishCheck()

  await expect(verifying).resolves.toMatchObject({ state: 'signed-in', username: 'new' })
  expect((await readMuseSession(file, 'https://muse.example'))?.cookie).toBe('__Host-muse=new')
})

it('does not remove a newer login when an older logout completes', async () => {
  const home = await accountHome()
  const file = join(home, 'session.json')
  await writeMuseSession(file, { baseUrl: 'https://muse.example', cookie: '__Host-muse=old', username: 'old' })
  let signalEntered!: () => void
  let finishLogout!: () => void
  const entered = new Promise<void>((resolve) => { signalEntered = resolve })
  const paused = new Promise<void>((resolve) => { finishLogout = resolve })
  const gateway: MuseAccountGateway = {
    signIn: async () => { throw new Error('unused') },
    register: async () => { throw new Error('unused') },
    identity: async () => { throw new Error('unused') },
    signOut: async () => { signalEntered(); await paused },
  }
  const account = new MuseAccountController({ baseUrl: 'https://muse.example', sessionFile: file, gateway })

  const signingOut = account.logout()
  await entered
  await writeMuseSession(file, { baseUrl: 'https://muse.example', cookie: '__Host-muse=new', username: 'new' })
  finishLogout()

  await expect(signingOut).resolves.toMatchObject({ state: 'signed-in', username: 'new' })
  expect((await readMuseSession(file, 'https://muse.example'))?.cookie).toBe('__Host-muse=new')
})

it('distinguishes locally saved identity from a current gateway verification and confirmed logout', async () => {
  const file = join(await accountHome(), 'session.json')
  const gateway: MuseAccountGateway = { signIn: async () => '__Host-muse=fixture', register: async () => '__Host-muse=fixture',
    identity: async () => ({ username: 'writer', workspaceLabel: 'Studio' }), signOut: async () => {} }
  const account = new MuseAccountController({ baseUrl: 'https://muse.example', sessionFile: file, gateway })
  expect(await account.status()).toEqual({ state: 'signed-out' })
  expect(await account.logout()).toEqual({ state: 'signed-out' })
  await account.login({ username: 'writer', password: 'password', registerIfMissing: false })
  expect(await account.status()).toEqual({ state: 'signed-in', username: 'writer', workspaceLabel: 'Studio', verified: false })
  expect(await account.status({ verify: true })).toEqual({ state: 'signed-in', username: 'writer', workspaceLabel: 'Studio', verified: true })
  expect(await account.logout()).toEqual({ state: 'signed-out' })
})

it.each([{ username: 'a', password: 'password' }, { username: 'x'.repeat(33), password: 'password' },
  { username: 'writer', password: '' }, { username: 'writer', password: 'x'.repeat(129) }])(
  'refuses invalid login field lengths before dispatch (%j)', async (fields) => {
    const gateway: MuseAccountGateway = { signIn: async () => { throw new Error('credentials dispatched') }, register: async () => '',
      identity: async () => ({ username: 'writer' }), signOut: async () => {} }
    const account = new MuseAccountController({ baseUrl: 'https://muse.example', sessionFile: join(await accountHome(), 'session.json'), gateway })
    await expect(account.login({ ...fields, registerIfMissing: false })).rejects.toMatchObject({ code: 'invalid-input' })
  },
)

it.each(['username-taken', 'registration-disabled'] as const)(
  'keeps password rejection distinct from registration failure (%s)', async (failure) => {
    const gateway: MuseAccountGateway = { signIn: async () => { throw new MuseGatewayError('invalid-credentials') },
      register: async () => { throw new MuseGatewayError(failure) }, identity: async () => ({ username: 'writer' }), signOut: async () => {} }
    const account = new MuseAccountController({ baseUrl: 'https://muse.example', sessionFile: join(await accountHome(), 'session.json'), gateway })
    await expect(account.login({ username: 'writer', password: 'password', registerIfMissing: true }))
      .rejects.toMatchObject({ code: failure === 'username-taken' ? 'invalid-credentials' : failure })
  },
)

it('retains a saved login when verification fails because the gateway is unavailable', async () => {
  const file = join(await accountHome(), 'session.json')
  await writeMuseSession(file, { baseUrl: 'https://muse.example', cookie: '__Host-muse=fixture', username: 'writer' })
  const account = new MuseAccountController({ baseUrl: 'https://muse.example', sessionFile: file, gateway: {
    signIn: async () => '', register: async () => '', identity: async () => { throw new MuseGatewayError('gateway-unavailable') }, signOut: async () => {},
  } })
  await expect(account.status({ verify: true })).rejects.toMatchObject({ code: 'gateway-unavailable' })
  expect((await readMuseSession(file, 'https://muse.example'))?.cookie).toBe('__Host-muse=fixture')
})

it('retains a saved login when an unexpected verification failure occurs', async () => {
  const file = join(await accountHome(), 'session.json')
  await writeMuseSession(file, { baseUrl: 'https://muse.example', cookie: '__Host-muse=fixture', username: 'writer' })
  const account = new MuseAccountController({ baseUrl: 'https://muse.example', sessionFile: file, gateway: {
    signIn: async () => '', register: async () => '', identity: async () => { throw new Error('unexpected gateway failure') }, signOut: async () => {},
  } })
  await expect(account.status({ verify: true })).rejects.toThrow('unexpected gateway failure')
  expect(await account.status()).toMatchObject({ state: 'signed-in', verified: false })
})

it('returns the replacement login when an older successful verification finishes', async () => {
  const file = join(await accountHome(), 'session.json')
  const baseUrl = 'https://muse.example'
  await writeMuseSession(file, { baseUrl, cookie: '__Host-muse=old', username: 'old' })
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const account = new MuseAccountController({ baseUrl, sessionFile: file, gateway: {
    signIn: async () => '', register: async () => '', signOut: async () => {},
    identity: async () => { entered(); await gate; return { username: 'old' } },
  } })
  const checking = account.status({ verify: true })
  await started
  await writeMuseSession(file, { baseUrl, cookie: '__Host-muse=new', username: 'new' })
  release()
  expect(await checking).toEqual({ state: 'signed-in', username: 'new', verified: false })
})
