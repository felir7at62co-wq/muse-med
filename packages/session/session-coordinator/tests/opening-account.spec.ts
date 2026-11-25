/** Account-scoped routing conversations and the opening turn's verified identity data. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MuseAccountService } from '@deepseek-ai/dsh-muse-account'
import type {
  MuseAccountDetails, MuseAccountDetailsRequest, MuseAccountFullDetails, MuseAccountGroupId,
  MuseAccountId, MuseAccountRelayDetails, MuseAccountStatus, MuseFeishuDepartmentId,
} from '@deepseek-ai/dsh-muse-account/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import Coordinator from '../src/index.ts'
import { greetRouter } from '../src/opening.ts'
import { setup, textResponse } from './fixture.ts'

const createdAt = '2026-09-01T09:00:00.000Z'
const account = { id: brandString<MuseAccountId>('account-123'), username: 'screen-name' }
const department = { id: brandString<MuseFeishuDepartmentId>('dept-1'), name: 'Story', path: 'Story', pathIds: [] }
const legacy: MuseAccountFullDetails = {
  account: { ...account, createdAt, lastLoginAt: null, lastActivityAt: null, feishuIdentities: [
    { name: 'Lin', tenantKey: null, boundAt: createdAt, lastLoginAt: null,
      organization: { status: 'available', syncedAt: createdAt, departments: [department] } },
    { name: 'Lin F.', tenantKey: null, boundAt: createdAt, lastLoginAt: null,
      organization: { status: 'available', syncedAt: createdAt,
        departments: [{ ...department, id: brandString<MuseFeishuDepartmentId>('dept-2') }] } },
    { name: 'Lin T.', tenantKey: null, boundAt: createdAt, lastLoginAt: null },
  ] },
  groups: [{ id: brandString<MuseAccountGroupId>('group-1'), name: 'Writers', description: 'Script writing' }],
  usage: { since: createdAt, updatedAt: createdAt, tracking: 'gateway-and-desktop',
    summary: { requests: 0, reportedRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0 },
    byModel: [], byDay: [], pagination: { offset: 0, limit: 1, total: 0, hasMore: false }, recent: [] },
}

const relay: MuseAccountRelayDetails = {
  protocol: 'account-data-v1', account,
  availability: { profile: 'unavailable', groups: 'unavailable', feishuOrganization: 'unavailable' },
  usage: { version: 1, coverage: { transport: 'relay-only', direct: 'unobserved' }, from: '2026-09-01', to: '2026-09-01',
    summary: { requests: 0, completedRequests: 0, failedRequests: 0, pendingRequests: 0, unknownRequests: 0, reportedUsageRequests: 0,
      partialUsageRequests: 0, unreportedUsageRequests: 0, inputTokens: null, outputTokens: null, totalTokens: null },
    items: [], nextCursor: null, health: { state: 'ok' } },
}

async function fixture(script: Parameters<typeof setup>[1] = [textResponse('Welcome'), textResponse('Hello')]) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-opening-account-'))
  const cleanup: { ctx?: Awaited<ReturnType<typeof setup>>['ctx'] } = {}
  onTestFinished(async () => {
    try { await cleanup.ctx?.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const test = await setup(root, script, undefined, { greetOnOpen: true })
  cleanup.ctx = test.ctx
  const status = vi.fn<() => Promise<MuseAccountStatus>>()
    .mockResolvedValue({ state: 'signed-in', username: account.username, verified: true })
  const details = vi.fn<(request: MuseAccountDetailsRequest) => Promise<MuseAccountDetails>>().mockResolvedValue(legacy)
  const identity = vi.fn<() => Promise<string>>().mockResolvedValue('ticket-a')
  await test.ctx.plugin(MuseAccountService, {
    controller: { status, details, logout: status, login: async () => { throw new Error('Unexpected fixture login') } },
    workbench: { identity, issue: async () => { throw new Error('Unexpected fixture workbench grant') } },
  })
  return { ...test, status, details, identity }
}

async function openingTexts(test: Awaited<ReturnType<typeof fixture>>, id: SessionId): Promise<string[]> {
  const agent = test.ctx.agents.get(id)
  if (agent === undefined) throw new Error('Opening Agent is unavailable')
  await agent.whenIdle()
  return agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'muse-router-opening'
    ? event.data.content.flatMap(item => item.type === 'text' ? [item.text] : [])
    : [])
}

it('keeps one verified conversation across login renewals and a later profile outage', async () => {
  const test = await fixture()
  const first = await test.service.openMain()
  const [opening] = await openingTexts(test, first)
  expect(JSON.parse(opening!)).toMatchObject({ signedInUser: { name: 'Lin', groups: ['Writers'], departments: ['Story'] } })
  expect(opening).not.toContain(account.id)
  expect(opening).not.toContain('ticket-a')
  expect(test.details).toHaveBeenCalledWith({ limit: 1 })

  test.identity.mockResolvedValue('ticket-b')
  expect(await test.service.openMain()).toBe(first)
  await test.fiber.dispose()
  await test.ctx.plugin(Coordinator, { greetOnOpen: true })
  test.details.mockRejectedValue(new Error('Profile unavailable'))
  expect(await test.ctx.sessionCoordinator.openMain()).toBe(first)
  expect(await openingTexts(test, first)).toEqual([opening])
})

it.each([
  { details: relay, departments: [] },
  { details: { ...relay, availability: { ...relay.availability, feishuOrganization: 'available' },
    organization: { status: 'available', updatedAt: createdAt, departments: [department] } }, departments: ['Story'] },
] satisfies { details: MuseAccountRelayDetails; departments: string[] }[])(
  'uses independently verified departments $departments when the relay has no personal profile', async ({ details, departments }) => {
    const test = await fixture()
    test.details.mockResolvedValue(details)
    const [opening] = await openingTexts(test, await test.service.openMain())
    expect(JSON.parse(opening!)).toMatchObject({ signedInUser: { name: account.username, groups: null, departments } })
  },
)

it('opens a signed-in fallback separately from the guest conversation if details are unavailable', async () => {
  const test = await fixture()
  test.status.mockResolvedValueOnce({ state: 'signed-out' })
  const guest = await test.service.openMain()
  expect(test.details).not.toHaveBeenCalled()
  expect(test.identity).not.toHaveBeenCalled()
  const [guestOpening] = await openingTexts(test, guest)
  expect(JSON.parse(guestOpening!)).toMatchObject({ signedInUser: null })

  test.details.mockRejectedValue(new Error('Profile unavailable'))
  const signedIn = await test.service.openMain()
  expect(signedIn).not.toBe(guest)
  const [opening] = await openingTexts(test, signedIn)
  expect(JSON.parse(opening!)).toMatchObject({ signedInUser: null })
  expect(await test.service.openMain()).toBe(signedIn)
  expect(await openingTexts(test, signedIn)).toEqual([opening])
})

it('keeps the same opening when the profile provider rejects with opaque data', async () => {
  const test = await fixture()
  vi.spyOn(test.ctx.museAccount, 'details').mockRejectedValueOnce('gateway response')
  test.details.mockRejectedValue(new Error('Profile remains unavailable'))
  const id = await test.service.openMain()
  const [opening] = await openingTexts(test, id)
  expect(JSON.parse(opening!)).toMatchObject({ signedInUser: null })
  expect(opening).not.toContain('gateway response')
  expect(await test.service.openMain()).toBe(id)
  expect(await openingTexts(test, id)).toEqual([opening])
})

it('propagates a status failure without opening a guest conversation', async () => {
  const test = await fixture()
  const create = vi.spyOn(test.ctx.sessionController, 'create')
  test.status.mockRejectedValueOnce(new Error('Private session could not be read'))
  await expect(test.service.openMain()).rejects.toMatchObject({ code: 'muse-account/storage-failed' })
  expect(create).not.toHaveBeenCalled()
  expect(test.details).not.toHaveBeenCalled()
})

it('rejects a login change during the profile read before provisioning a conversation', async () => {
  const test = await fixture()
  const create = vi.spyOn(test.ctx.sessionController, 'create')
  test.details.mockImplementationOnce(async () => {
    test.identity.mockResolvedValue('ticket-b')
    return legacy
  })
  await expect(test.service.openMain()).rejects.toThrow('Muse account changed while opening its conversation')
  expect(create).not.toHaveBeenCalled()
})

it('withholds the opening turn and the stale login alias when the login changes during Agent resolution', async () => {
  const test = await fixture()
  const resolve = test.ctx.sessionController.resolveAgent.bind(test.ctx.sessionController)
  const resolving = vi.spyOn(test.ctx.sessionController, 'resolveAgent').mockImplementationOnce(async (id) => {
    const result = await resolve(id)
    test.identity.mockResolvedValue('ticket-b')
    return result
  })
  await expect(test.service.openMain()).rejects.toThrow('Muse account changed while opening its conversation')
  const [interrupted] = resolving.mock.calls[0]!
  expect(await openingTexts(test, interrupted)).toEqual([])

  test.identity.mockResolvedValue('ticket-a')
  test.details.mockRejectedValueOnce(new Error('Profile unavailable'))
  const fallback = await test.service.openMain()
  expect(fallback).not.toBe(interrupted)
  const [opening] = await openingTexts(test, fallback)
  expect(JSON.parse(opening!)).toMatchObject({ signedInUser: null })
  expect(await openingTexts(test, interrupted)).toEqual([])
})

it('leaves queued human input in place and remembers it if canceled before consumption', async () => {
  const test = await fixture()
  const agent = await test.makeAgent('queued-main', 'main-session')
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Check this draft' }] })
  agent.send(human, 'next-turn', false)
  expect(agent.status).toBe('idle')
  expect(greetRouter(agent, null, agent.session.snapshotEvents())).toBe(false)
  expect(agent.inbox.nextTurn).toEqual([human])

  agent.inbox.clear()
  expect(agent.inbox.nextTurn).toEqual([])
  expect(greetRouter(agent, null, agent.session.snapshotEvents())).toBe(false)
  expect(await openingTexts(test, agent.id)).toEqual([])
})

it('does not queue an opening while the Agent is already running a nonhuman turn', async () => {
  const test = await fixture(['hang'])
  const agent = await test.makeAgent('running-main', 'main-session')
  const started = Promise.withResolvers<undefined>()
  const stream = test.adapter.stream.bind(test.adapter)
  vi.spyOn(test.adapter, 'stream').mockImplementation((options) => {
    started.resolve(undefined)
    return stream(options)
  })
  agent.followup(createUserMessage({ source: { kind: 'schedule' },
    content: [{ type: 'text', text: 'Check the workspace' }] }))
  await started.promise
  expect(agent.status).toBe('running')
  expect(agent.inbox.nextTurn).toEqual([])
  expect(greetRouter(agent, null, agent.session.snapshotEvents())).toBe(false)
  expect(agent.inbox.nextTurn).toEqual([])
  agent.cancel({ kind: 'user' })
  expect(await openingTexts(test, agent.id)).toEqual([])
})

it.each(['a human request', 'the opening'] as const)('respects %s already materialized in the Session transcript', async (input) => {
  const test = await fixture()
  const agent = await test.makeAgent('materialized-main', 'main-session')
  if (input === 'a human request') {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Check the draft' }] }))
  } else {
    expect(greetRouter(agent, null, agent.session.snapshotEvents())).toBe(true)
  }
  await agent.whenIdle()
  const transcript = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
  expect(transcript).toHaveLength(1)
  expect(greetRouter(agent, null, transcript)).toBe(false)
  expect(await openingTexts(test, agent.id)).toHaveLength(input === 'the opening' ? 1 : 0)
})
