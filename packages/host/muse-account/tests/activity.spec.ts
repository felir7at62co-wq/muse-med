import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { mountMuseActivity, MuseActivityReporter } from '../src/activity.ts'
import { writeMuseSession } from '../src/session.ts'
import { GoalId } from '../../../goal/goal/src/runtime.ts'
import type {} from '../../../goal/goal/src/domain.ts'
import * as sessionStorage from '../src/session.ts'

const homes: string[] = [], contexts: Context[] = [], reporters: MuseActivityReporter[] = []
afterEach(async () => {
  await Promise.all(reporters.splice(0).map(reporter => reporter.dispose()))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function fixture(fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })), requestTimeoutMs = 1000) {
  const home = await mkdtemp(join(tmpdir(), 'muse-activity-')); homes.push(home)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SessionStore)
  const options = { baseUrl: 'https://muse.example', sessionFile: join(home, 'session.json'),
    reportIntervalMs: 30_000, requestTimeoutMs, fetcher }
  await writeMuseSession(options.sessionFile, { baseUrl: options.baseUrl, username: 'alice', cookie: '__Host-muse=alice-private' })
  const reporter = new MuseActivityReporter(options); reporters.push(reporter)
  const detach = ctx.on('session/event', (session, event) => { reporter.observe(session, event) })
  const session = ctx.sessions.create(SessionId('root'))
  return { ctx, options, reporter, session, fetcher, detach }
}

function human(session: Session, text = 'Private task title, paths, transcript and content'): void {
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
}

function turn(session: Session, number: number): void {
  session.append('turn/start', { turn: number })
  human(session)
  session.append('turn/end', { turn: number, reason: { kind: 'completed' } })
}

it('reports only a minimal authenticated same-origin marker and never content or client timestamps', async () => {
  const { session, reporter, fetcher } = await fixture()
  turn(session, 1)
  await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
  await reporter.dispose()
  const [url, init] = fetcher.mock.calls[0]!
  if (!(url instanceof URL)) throw Error('Activity destination must be a URL')
  expect(url.href).toBe('https://muse.example/api/muse.activity')
  expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: '{"activity":"task-start"}' })
  expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
    'content-type': 'application/json', origin: 'https://muse.example', cookie: '__Host-muse=alice-private',
  })
  expect(init?.signal).toBeInstanceOf(AbortSignal)
  expect(init?.body).not.toContain('Private')
})

it('counts one admitted human turn even with more human messages or delayed model steps in that turn', async () => {
  let now = 100_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const { session, reporter, fetcher } = await fixture()
  session.append('turn/start', { turn: 1 }); human(session)
  await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
  now += 40_000; human(session, 'Another human message in the same open turn')
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  turn(session, 2)
  await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(2) })
  await reporter.dispose()
})

it('throttles successive human turns for the same login without delaying the appended input', async () => {
  let now = 100_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const { options, session, reporter, fetcher } = await fixture()
  const login = await sessionStorage.readMuseSession(options.sessionFile, options.baseUrl)
  const read = vi.spyOn(sessionStorage, 'readMuseSession').mockResolvedValue(login)
  turn(session, 1)
  await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
  turn(session, 2)
  await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(3) })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(fetcher).toHaveBeenCalledOnce()
  now += 40_000
  turn(session, 3)
  await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(2) })
  expect(session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(3)
  await reporter.dispose()
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('excludes goal continuations, subagents, delegated children, and user messages outside a live turn', async () => {
  const { ctx, session, reporter, fetcher } = await fixture()
  const read = vi.spyOn(sessionStorage, 'readMuseSession')
  human(session)
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'goal', goalId: GoalId('automatic-goal'), revision: 1, round: 1 }, content: [{ type: 'text', text: 'Automatic input' }] }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (const [id, meta] of [['child', { origin: 'subagent' }], ['depth', { delegationDepth: 1 }]] as const) {
    turn(ctx.sessions.create(SessionId(id), { meta }), 1)
  }
  expect(read).not.toHaveBeenCalled()
  await reporter.dispose()
  expect(fetcher).not.toHaveBeenCalled()
})

it('counts a human turn in a manually forked root Session', async () => {
  const { ctx, reporter, fetcher } = await fixture()
  const fork = ctx.sessions.create(SessionId('manual-fork'), { meta: { parentSession: SessionId('root') } })
  turn(fork, 1)
  await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
  await reporter.dispose()
})

it('does not replay already persisted input when the observer attaches later', async () => {
  const { ctx, options, session } = await fixture()
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
  turn(session, 1)
  mountMuseActivity(ctx, { ...options, fetcher })
  await ctx.fiber.dispose()
  expect(fetcher).not.toHaveBeenCalled()
})

it('removes the committed-event observer on plugin disposal and can mount a fresh reporter', async () => {
  const { ctx, options, session, reporter, fetcher, detach } = await fixture()
  detach()
  await reporter.dispose()
  const observe = vi.spyOn(MuseActivityReporter.prototype, 'observe')
  const owner = ctx.plugin({ name: 'activity-lifecycle', apply: (scope) => { mountMuseActivity(scope, options) } })
  await owner
  turn(session, 1)
  await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
  await owner.dispose()
  observe.mockClear()
  turn(session, 2)
  expect(observe).not.toHaveBeenCalled()
  const replacement = ctx.plugin({ name: 'activity-replacement', apply: (scope) => { mountMuseActivity(scope, options) } })
  await replacement
  turn(session, 3)
  await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(2) })
  await replacement.dispose()
})

it.each(['missing', 'foreign', 'malformed'])('drops activity when the saved login is %s', async (kind) => {
  const { options, session, reporter, fetcher } = await fixture()
  if (kind === 'missing') await rm(options.sessionFile)
  if (kind === 'foreign') await writeMuseSession(options.sessionFile, {
    baseUrl: 'https://other.example', username: 'alice', cookie: '__Host-muse=foreign-private',
  })
  if (kind === 'malformed') await writeFile(options.sessionFile, '{broken')
  turn(session, 1)
  await reporter.dispose()
  expect(fetcher).not.toHaveBeenCalled()
})

it('uses the new login on a later human turn without inheriting the prior login throttle', async () => {
  const { options, session, reporter, fetcher } = await fixture()
  turn(session, 1)
  await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
  await writeMuseSession(options.sessionFile, { baseUrl: options.baseUrl, username: 'bob', cookie: '__Host-muse=bob-private' })
  turn(session, 2)
  await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(2) })
  await reporter.dispose()
  expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('cookie')).toBe('__Host-muse=bob-private')
})

it('rechecks the captured login before dispatch and never reassigns an earlier turn to a new account', async () => {
  const { options, session, reporter, fetcher } = await fixture()
  const read = sessionStorage.readMuseSession
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let calls = 0, rechecked = false
  vi.spyOn(sessionStorage, 'readMuseSession').mockImplementation(async (...args) => {
    if (++calls !== 2) return await read(...args)
    await blocked
    const current = await read(...args)
    rechecked = true
    return current
  })
  turn(session, 1)
  await vi.waitFor(() => { expect(calls).toBe(2) })
  await writeMuseSession(options.sessionFile, { baseUrl: options.baseUrl, username: 'bob', cookie: '__Host-muse=bob-private' })
  release()
  await vi.waitFor(() => { expect(rechecked).toBe(true) })
  turn(session, 2)
  await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
  await reporter.dispose()
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('cookie')).toBe('__Host-muse=bob-private')
})

it('contains rejected requests and does not retry unknown activity writes', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => { throw Error('Network request contains private details') })
  const { session, reporter } = await fixture(fetcher)
  turn(session, 1)
  await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
  turn(session, 2)
  await reporter.dispose()
  expect(fetcher).toHaveBeenCalledOnce()
})

it('aborts an outstanding request and awaits its cleanup before disposal resolves', async () => {
  let cleaned = false
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { cleaned = true; reject(Error('Request cancelled')) }, { once: true })
  }))
  const { session, reporter } = await fixture(fetcher)
  turn(session, 1)
  await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
  await reporter.dispose()
  expect(cleaned).toBe(true)
  turn(session, 2)
  expect(fetcher).toHaveBeenCalledOnce()
})

it('ends a stalled request at its bounded deadline without blocking the completed turn', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { reject(Error('Request cancelled')) }, { once: true })
  }))
  const { session, reporter } = await fixture(fetcher, 100)
  turn(session, 1)
  expect(session.snapshotEvents().at(-1)?.type).toBe('turn/end')
  await vi.waitFor(() => { expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true) })
  await reporter.dispose()
})
