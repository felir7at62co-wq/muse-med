/** Real HTTP update handoff for the retained Bot route used by legacy Desktop builds. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { installDesktopUpdateTaskControl } from '../../../../apps/desktop-host/src/update-tasks.ts'
import { bridge } from '../../../../packages/client/connection/src/http-bridge.ts'
import { createBrowserChannel } from '../src/host/browser.js'
import { install as installChannel } from '../src/host/channel.js'

async function beforeDeadline(promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Browser poll exceeded the Desktop update deadline')), 10_000)
    })])
  } finally { clearTimeout(timer) }
}

async function probe(ctx, expectedActiveTasks) {
  const connection = ctx.get('connection') ?? new HostConnectionService(ctx, [], {})
  const inspect = installDesktopUpdateTaskControl(ctx)
  const channel = createBrowserChannel()
  const polls = [Promise.withResolvers(), Promise.withResolvers()]
  const firstClosed = Promise.withResolvers()
  const wait = channel.wait
  const waiting = new Set()
  const handling = new Set()
  const errors = []
  const clients = []
  let enteredPolls = 0
  let locking
  let updateLocked = false
  channel.wait = (...args) => {
    const pending = wait(...args)
    waiting.add(pending)
    pending.then(() => waiting.delete(pending), () => waiting.delete(pending))
    polls[enteredPolls++]?.resolve({ signal: args[2] })
    return pending
  }
  const rt = {
    ctx, state: { bots: {}, rooms: {}, prefs: {} }, pastOwners: new Map(),
    browserChannel: channel, browserOpen: value => value,
    refresh: async () => {}, load: async () => {}, readOnly: () => undefined,
    warn() {}, noteFailure(failure) { errors.push(failure) },
  }
  installChannel(rt)
  const handler = connection.createSharedFetchHandler('/api')
  const server = createServer((request, response) => {
    if (enteredPolls === 0) response.once('close', () => firstClosed.resolve())
    const pending = ctx.waterfall('connection/request', request, response,
      () => bridge(request, response, handler, connection.browserPeer))
    handling.add(pending)
    pending.then(() => handling.delete(pending), (error) => {
      handling.delete(pending)
      errors.push(error)
      if (!response.destroyed) response.destroy(error)
    })
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  try {
    await listening
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const post = (endpoint = 'browser-wait', payload = {
      clientId: 'update-window', open: { 'update-bot': { url: 'https://example.invalid/' } },
    }) => {
      const controller = new AbortController()
      const done = fetch(`http://127.0.0.1:${address.port}/api/bot`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload }),
      }).then(response => response.json()).then(value => ({ value }), error => ({ error }))
      clients.push({ controller, done })
      return done
    }
    const interrupted = post()
    const first = await beforeDeadline(polls[0].promise)
    assert.equal(await inspect('inspect'), expectedActiveTasks)
    updateLocked = true
    locking = inspect('lock').then(value => ({ value }), error => ({ error }))
    await beforeDeadline(firstClosed.promise)
    assert.equal(first.signal?.aborted, true, 'The real Bot route must forward the disconnected HTTP request signal')
    assert.deepEqual(await beforeDeadline(locking), { value: expectedActiveTasks })
    assert.ok((await interrupted).error instanceof Error)
    assert.equal(waiting.size, 0)

    assert.equal(await inspect('unlock'), expectedActiveTasks)
    updateLocked = false
    const resumed = post()
    await beforeDeadline(polls[1].promise)
    const reading = channel.read('update-bot')
    const response = await beforeDeadline(resumed)
    assert.equal(response.value?.ok, true)
    const requests = response.value.value.requests
    assert.equal(requests.length, 1)
    assert.equal(requests[0].botId, 'update-bot')
    const page = { url: 'https://example.invalid/', text: 'The same window resumed after update deferral.' }
    assert.deepEqual(await post('browser-result', { id: requests[0].id, ok: true, page }),
      { value: { ok: true, value: true } })
    assert.deepEqual(await reading, { page })
    await Promise.all([...handling])
    assert.equal(waiting.size, 0)
    assert.equal(handling.size, 0)
    assert.deepEqual(errors, [])
    return { interruptedPollCancelled: true, lockCompletedBeforeDeadline: true,
      activeTasksRetained: expectedActiveTasks, resumedPollCount: requests.length,
      resumedReadCompleted: true, pendingPolls: waiting.size, pendingHandlers: handling.size }
  } finally {
    channel.dispose()
    for (const client of clients) client.controller.abort()
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await Promise.allSettled(clients.map(client => client.done))
    await Promise.allSettled([...waiting, ...handling, ...(locking ? [locking] : [])])
    if (updateLocked) await inspect('unlock')
    await closed
  }
}

/**
 * Run a scoped legacy-route probe without changing the caller's configured Desktop profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Owner of the probe's temporary registrations.
 * @param {{expectedActiveTasks?: boolean}} options - Expected state of the caller's live Agent and job services.
 * @returns {Promise<object>} Observed cancellation, resume, and cleanup results.
 */
export async function runBrowserUpdateDrainProbe(ctx, { expectedActiveTasks = false } = {}) {
  const completed = Promise.withResolvers()
  const fiber = ctx.plugin(async (owner) => {
    try { completed.resolve(await probe(owner, expectedActiveTasks)) }
    catch (error) { completed.reject(error) }
  })
  try { return await completed.promise }
  finally { await fiber.dispose() }
}
