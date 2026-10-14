import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { MuseGatewayError } from '../src/gateway.ts'
import { MuseAccountController, MuseAccountInputError } from '../src/account.ts'
import { MuseFeedbackError } from '../src/feedback.ts'
import { MuseAccountService } from '../src/service.ts'
import { MuseAsrClient } from '../src/asr.ts'
import { readMuseSession, writeMuseSession } from '../src/session.ts'
import type { MuseAccountStatus } from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

it('publishes account setup and explicit inbox submission over the authenticated Remote namespace', async () => {
  const context = new Context()
  contexts.push(context)
  const controller = {
    status: async (): Promise<MuseAccountStatus> => ({ state: 'signed-out' }),
    login: async () => { throw new MuseGatewayError('invalid-credentials') },
    logout: async (): Promise<MuseAccountStatus> => ({ state: 'signed-out' }),
  }
  await context.plugin(MuseAccountService, { controller })
  const service = context.get('museAccount') as MuseAccountService

  expect(remoteMethods(service).map(entry => entry.method)).toEqual(['feedback', 'status', 'login', 'logout'])
  await expect(service.feedback({ sessionId: 'session' as never, target: { kind: 'session' }, includeDiagnostics: false }))
    .rejects.toMatchObject({ code: 'muse-feedback/unavailable', details: {} })
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

it('forwards the receipt purpose through the Host service without adding transcription to Remote', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-asr-service-'))
  const context = new Context(), id = randomUUID(), headers: Headers[] = []
  try {
    const sessionFile = join(dir, 'session.json'), file = join(dir, 'clip.wav')
    await writeMuseSession(sessionFile, { baseUrl: 'https://muse.test', cookie: '__Host-muse=fixture-session', username: 'alice' })
    await writeFile(file, 'fixture audio')
    const status = async (): Promise<MuseAccountStatus> => ({ state: 'signed-in', username: 'alice', verified: false })
    const asr = new MuseAsrClient({ baseUrl: 'https://muse.test', sessionFile, requestTimeoutMs: 1000,
      fetcher: async (_url, init) => { headers.push(new Headers(init?.headers)); return new Response(JSON.stringify({ id, status: 'processing', purpose: 'screenplay', service_version: 'standard-v2', app_key: 'private-provider-value' })) },
    })
    await context.plugin(MuseAccountService, { controller: { status, login: async () => { throw new Error('Unused fixture login') }, logout: status }, asr })
    const service = context.get('museAccount') as MuseAccountService
    expect(await service.submitAudio(file, id, 'a'.repeat(64), 'zh', 'screenplay')).toEqual({ id, status: 'processing', purpose: 'screenplay', service_version: 'standard-v2' })
    await service.audioStatus(id)
    expect(headers.map(row => row.get('x-muse-asr-purpose'))).toEqual(['screenplay', null])
    expect(remoteMethods(service).map(entry => entry.method)).toEqual(['feedback', 'status', 'login', 'logout'])
    const controller = new AbortController(), reason = new Error('cancelled service call')
    controller.abort(reason)
    await expect(service.submitAudio(file, id, 'a'.repeat(64), 'zh', 'screenplay', controller.signal)).rejects.toBe(reason)
    await expect(service.audioStatus(id, controller.signal)).rejects.toBe(reason)
    expect(headers).toHaveLength(2)
  } finally {
    await context.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

it('orders account refresh and disconnect operations and returns an explicit feedback receipt', async () => {
  const context = new Context(), operations: string[] = []
  contexts.push(context)
  const signedOut = { state: 'signed-out' } as const
  await context.plugin(MuseAccountService, { controller: {
    status: async () => { operations.push('status'); return signedOut },
    login: async () => { operations.push('login'); return { outcome: 'signed-in', status: { state: 'signed-in', username: 'writer', verified: true } } },
    logout: async () => { operations.push('logout'); return signedOut },
  }, models: { refresh: async () => { operations.push('models') } }, remote: {
    refresh: async () => { operations.push('remote') }, pause: async () => { operations.push('pause') },
  }, feedback: { submit: async () => ({ id: 'feedback' as never, revision: 1 }) } })
  const service = context.get('museAccount') as MuseAccountService
  expect(await service.status({})).toEqual(signedOut)
  await service.login({ username: 'writer', password: 'password', registerIfMissing: false })
  expect(await service.logout()).toEqual(signedOut)
  expect(operations).toEqual(['status', 'remote', 'models', 'login', 'remote', 'models', 'pause', 'logout', 'models'])
  expect(await service.feedback({ sessionId: 'session' as never, target: { kind: 'session' }, includeDiagnostics: false }))
    .toEqual({ id: 'feedback', revision: 1 })
})

it('returns login success and keeps the saved session when the model catalog refresh fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-login-refresh-'))
  const context = new Context()
  contexts.push(context)
  const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined)
  const sessionFile = join(dir, 'session.json')
  const controller = new MuseAccountController({
    baseUrl: 'https://muse.test', sessionFile,
    gateway: {
      signIn: async () => '__Host-muse=saved-session',
      register: async () => { throw new Error('unexpected registration') },
      identity: async () => ({ username: 'writer' }),
      signOut: async () => {},
    },
  })
  try {
    await context.plugin(MuseAccountService, { controller, models: {
      refresh: async () => { throw new MuseGatewayError('gateway-unavailable') },
    } })
    const service = context.get('museAccount') as MuseAccountService

    await expect(service.login({ username: 'writer', password: 'password', registerIfMissing: false }))
      .resolves.toEqual({ outcome: 'signed-in', status: { state: 'signed-in', username: 'writer', verified: true } })
    expect(await readMuseSession(sessionFile, 'https://muse.test')).toMatchObject({
      username: 'writer', cookie: '__Host-muse=saved-session',
    })
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Muse model catalog refresh failed after login; the saved account remains signed in.',
      expect.objectContaining({ code: 'gateway-unavailable' }),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('continues to model refresh and returns login success when desktop refresh fails', async () => {
  const context = new Context(), operations: string[] = []
  contexts.push(context)
  const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined)
  await context.plugin(MuseAccountService, { controller: {
    status: async () => ({ state: 'signed-out' }),
    login: async () => { operations.push('login'); return { outcome: 'signed-in', status: { state: 'signed-in', username: 'writer', verified: true } } },
    logout: async () => ({ state: 'signed-out' }),
  }, remote: {
    refresh: async () => { operations.push('remote'); throw new Error('private desktop refresh detail') },
    pause: async () => {},
  }, models: { refresh: async () => { operations.push('models') } } })
  const service = context.get('museAccount') as MuseAccountService

  await expect(service.login({ username: 'writer', password: 'password', registerIfMissing: false }))
    .resolves.toMatchObject({ outcome: 'signed-in', status: { state: 'signed-in', username: 'writer' } })
  expect(operations).toEqual(['login', 'remote', 'models'])
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    'Muse desktop connection refresh failed after login; the saved account remains signed in.',
    expect.objectContaining({ message: 'private desktop refresh detail' }),
  )
})

it('returns the saved account after restart when desktop and model refreshes fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-status-refresh-'))
  const context = new Context(), operations: string[] = []
  contexts.push(context)
  const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined)
  const sessionFile = join(dir, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: 'https://muse.test', cookie: '__Host-muse=saved-session', username: 'writer' })
  const controller = new MuseAccountController({ baseUrl: 'https://muse.test', sessionFile, gateway: {
    signIn: async () => { throw new Error('unused') }, register: async () => { throw new Error('unused') },
    identity: async () => { throw new Error('local status must not verify') }, signOut: async () => {},
  } })
  try {
    await context.plugin(MuseAccountService, { controller, remote: {
      refresh: async () => { operations.push('remote'); throw new Error('private desktop refresh detail') }, pause: async () => {},
    }, models: { refresh: async () => { operations.push('models'); throw new MuseGatewayError('gateway-unavailable') } } })
    const service = context.get('museAccount') as MuseAccountService

    await expect(service.status({ verify: false }))
      .resolves.toEqual({ state: 'signed-in', username: 'writer', verified: false })
    expect(operations).toEqual(['remote', 'models'])
    expect(await readMuseSession(sessionFile, 'https://muse.test')).toMatchObject({ username: 'writer' })
    expect(warn).toHaveBeenNthCalledWith(1,
      'Muse desktop connection refresh failed while reading account status; the saved account state remains authoritative.',
      expect.objectContaining({ message: 'private desktop refresh detail' }),
    )
    expect(warn).toHaveBeenNthCalledWith(2,
      'Muse model catalog refresh failed while reading account status; the saved account state remains authoritative.',
      expect.objectContaining({ code: 'gateway-unavailable' }),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('clears a session rejected by explicit identity verification even when follow-up refreshes fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-status-rejected-'))
  const context = new Context()
  contexts.push(context)
  vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined)
  const sessionFile = join(dir, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: 'https://muse.test', cookie: '__Host-muse=expired-session', username: 'writer' })
  const controller = new MuseAccountController({ baseUrl: 'https://muse.test', sessionFile, gateway: {
    signIn: async () => { throw new Error('unused') }, register: async () => { throw new Error('unused') },
    identity: async () => { throw new MuseGatewayError('invalid-credentials') }, signOut: async () => {},
  } })
  try {
    await context.plugin(MuseAccountService, { controller, remote: {
      refresh: async () => { throw new Error('desktop cleanup unavailable') }, pause: async () => {},
    }, models: { refresh: async () => { throw new MuseGatewayError('gateway-unavailable') } } })
    const service = context.get('museAccount') as MuseAccountService

    await expect(service.status({ verify: true })).resolves.toEqual({ state: 'signed-out' })
    expect(await readMuseSession(sessionFile, 'https://muse.test')).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('keeps the saved session and skips refreshes when explicit identity verification cannot reach the gateway', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-status-unavailable-'))
  const context = new Context()
  contexts.push(context)
  const sessionFile = join(dir, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: 'https://muse.test', cookie: '__Host-muse=saved-session', username: 'writer' })
  const controller = new MuseAccountController({ baseUrl: 'https://muse.test', sessionFile, gateway: {
    signIn: async () => { throw new Error('unused') }, register: async () => { throw new Error('unused') },
    identity: async () => { throw new MuseGatewayError('gateway-unavailable') }, signOut: async () => {},
  } })
  const remote = { refresh: vi.fn(async () => {}), pause: async () => {} }
  const models = { refresh: vi.fn(async () => {}) }
  try {
    await context.plugin(MuseAccountService, { controller, remote, models })
    const service = context.get('museAccount') as MuseAccountService

    await expect(service.status({ verify: true })).rejects.toMatchObject({ code: 'muse-account/gateway-unavailable' })
    expect(await readMuseSession(sessionFile, 'https://muse.test')).toMatchObject({ username: 'writer' })
    expect(remote.refresh).not.toHaveBeenCalled()
    expect(models.refresh).not.toHaveBeenCalled()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it.each(['username-taken', 'rate-limited', 'registration-disabled', 'gateway-unavailable', 'gateway-rejected', 'input'] as const)(
  'bounds login failure text for %s', async (failure) => {
    const context = new Context(); contexts.push(context)
    await context.plugin(MuseAccountService, { controller: {
      status: async () => ({ state: 'signed-out' }), logout: async () => ({ state: 'signed-out' }),
      login: async () => { throw failure === 'input' ? new MuseAccountInputError() : new MuseGatewayError(failure) },
    } })
    const service = context.get('museAccount') as MuseAccountService
    await expect(service.login({ username: 'writer', password: 'password', registerIfMissing: false }))
      .rejects.toMatchObject({ code: `muse-account/${failure === 'input' ? 'invalid-input' : failure === 'username-taken' ? 'invalid-credentials' : failure}`, details: {} })
  },
)

it('keeps logout and feedback failures fixed and reports missing cloud transcription explicitly', async () => {
  const context = new Context(); contexts.push(context)
  await context.plugin(MuseAccountService, { controller: {
    status: async () => ({ state: 'signed-out' }), login: async () => { throw new Error('unused') },
    logout: async () => { throw new Error('PRIVATE_STORAGE') },
  }, feedback: { submit: async () => { throw new Error('PRIVATE_RECEIPT') } } })
  const service = context.get('museAccount') as MuseAccountService
  await expect(service.logout()).rejects.toMatchObject({ code: 'muse-account/storage-failed' })
  await expect(service.feedback({ sessionId: 'session' as never, target: { kind: 'session' }, includeDiagnostics: false }))
    .rejects.toMatchObject({ code: 'muse-feedback/unavailable' })
  await expect(service.submitAudio('/missing', 'id', 'digest', 'zh')).rejects.toThrow('unavailable')
  await expect(service.audioStatus('id')).rejects.toThrow('unavailable')
})

it('preserves a recognized feedback refusal without forwarding its local detail', async () => {
  const context = new Context(); contexts.push(context)
  await context.plugin(MuseAccountService, { controller: {
    status: async () => ({ state: 'signed-out' }), login: async () => { throw new Error('unused') }, logout: async () => ({ state: 'signed-out' }),
  }, feedback: { submit: async () => { throw new MuseFeedbackError('account-changed') } } })
  const service = context.get('museAccount') as MuseAccountService
  await expect(service.feedback({ sessionId: 'session' as never, target: { kind: 'session' }, includeDiagnostics: false }))
    .rejects.toMatchObject({ code: 'muse-feedback/account-changed' })
})

it('keeps voice coordination Host-only and explicitly reports a missing provider', async () => {
  const context = new Context(); contexts.push(context)
  const controller = { status: async (): Promise<MuseAccountStatus> => ({ state: 'signed-out' }),
    login: async () => { throw new Error('Unused') }, logout: async (): Promise<MuseAccountStatus> => ({ state: 'signed-out' }) }
  await context.plugin(MuseAccountService, { controller })
  const service = context.get('museAccount') as MuseAccountService
  const request = { action: 'read' as const, script_id: 2708, character_id: 'zhou', voice_period_id: 'adult', operation_key: 'original-key' }
  await expect(service.requestVoiceSlot(request, 'private-provider')).rejects.toMatchObject({ code: 'not-configured' })
  expect(remoteMethods(service).map(row => row.method)).not.toContain('requestVoiceSlot')
  const next = new Context(); contexts.push(next)
  const calls: string[] = []
  await next.plugin(MuseAccountService, { controller, voiceSlots: { request: async (value, token) => {
    expect(value).toEqual(request); calls.push(token); return { state: 'available' }
  } } })
  expect(await next.museAccount.requestVoiceSlot(request, 'private-provider')).toEqual({ state: 'available' })
  expect(calls).toEqual(['private-provider'])
})
