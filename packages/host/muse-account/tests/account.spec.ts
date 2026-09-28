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
