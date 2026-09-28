import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it } from 'vitest'
import { MuseGatewayError } from '../src/gateway.ts'
import { MuseAccountService } from '../src/service.ts'
import type { MuseAccountStatus } from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

it('publishes only status, login and logout over the authenticated Remote namespace', async () => {
  const context = new Context()
  contexts.push(context)
  const controller = {
    status: async (): Promise<MuseAccountStatus> => ({ state: 'signed-out' }),
    login: async () => { throw new MuseGatewayError('invalid-credentials') },
    logout: async (): Promise<MuseAccountStatus> => ({ state: 'signed-out' }),
  }
  await context.plugin(MuseAccountService, { controller })
  const service = context.get('museAccount') as MuseAccountService

  expect(remoteMethods(service).map(entry => entry.method)).toEqual(['status', 'login', 'logout'])
  await expect(service.login({ username: 'writer', password: 'secret-value', registerIfMissing: false }))
    .rejects.toMatchObject({ code: 'muse-account/invalid-credentials', details: {} })
})

it('never forwards an unexpected storage error message across Remote', async () => {
  const context = new Context()
  contexts.push(context)
  const controller = {
    status: async () => { throw new Error('secret-value from a damaged session') },
    login: async () => { throw new Error('unexpected') },
    logout: async () => { throw new Error('unexpected') },
  }
  await context.plugin(MuseAccountService, { controller })
  const service = context.get('museAccount') as MuseAccountService

  await expect(service.status({ verify: false })).rejects.toMatchObject({
    code: 'muse-account/storage-failed',
    message: 'MUSE account session could not be read or updated',
  })
})
