/** Browser handoff retries retain one real Agent admission after a failed flush acknowledgement. */
import assert from 'node:assert/strict'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createBrowserChannel } from '../../../third_party/plugins/ds-bot/src/host/browser.js'
import { install as installChannel } from '../../../third_party/plugins/ds-bot/src/host/channel.js'

const botId = 'snapshot-handoff-bot'
const handoffCallId = 'snapshot-browser-handoff-1'
const toolCallId = 'call_handoff_flush_recovery'
const toolName = 'snapshot_browser_handoff_recovery'
const replyKind = 'user-question-reply'
const flushFailureText = 'Synthetic handoff flush acknowledgement failure'
const firstAnswer = 'The handoff answer was admitted once. Its queued reply will continue this conversation.'
const finalAnswer = 'The admitted browser handoff answer reached this turn exactly once.'

/** Loader identity for the browser handoff recovery conversation. */
export const name = 'snapshot-browser-handoff-flush-recovery'
/** Native Agent, Session persistence, tool and Connection services remain real. */
export const inject = ['tools', 'llm', 'agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'connection']

const isReply = message => message?.source?.kind === replyKind && message.source.callId === handoffCallId
const admissions = events => events.filter(event => event.type === 'agent/inbox/spliced')
  .flatMap(event => event.data.inserted ?? []).filter(isReply)
const visibleReplies = messages => messages.filter(message => message.role === 'user')
  .flatMap(message => message.content.filter(block => block.type === 'text').flatMap(block => {
    let value
    try { value = JSON.parse(block.text) }
    catch (_error) { return [] /* Other user messages are ordinary text. */ }
    return value?.kind === 'answer_to_pending_handoff' && value.callId === handoffCallId ? [value] : []
  }))

async function persistedEvents(ctx, agent) {
  await ctx.sessions.flush(agent.session)
  const handle = await ctx.sessionPersistence.open(agent.session.id, 'read')
  try { return (await handle.read()).events }
  finally { await handle.close() }
}

/**
 * Drive the production channel against one real executing Agent without browser I/O.
 * @param ctx - Headless Loader context owning the channel, route and injected fault.
 * @returns Completion after the route and fixture tool are ready.
 */
export function apply(ctx) {
  const state = { bots: {}, rooms: {}, agents: {}, prefs: {}, views: {}, questions: {} }
  const browserChannel = createBrowserChannel()
  ctx.effect(() => () => browserChannel.dispose())
  let activeAgent, armed = false, flushFailures = 0, ran = false, resultText
  let resultVisible = false, replyRequestCount = 0, completedTurns = 0
  const diagnostics = []
  const runtime = {
    ctx, state, browserChannel, pastOwners: new Map(),
    load: async () => state,
    refresh: async () => {},
    readOnly: () => undefined,
    botOf: id => state.bots[id],
    chatOf: id => state.bots[id]?.sessionId,
    async ensureCapabilities(sessionId) {
      assert.equal(sessionId, activeAgent.id)
      assert.ok(ctx.tools.schemas(activeAgent).some(tool => tool.name === toolName))
    },
    async resolveAgent(sessionId) {
      assert.equal(sessionId, activeAgent.id)
      assert.equal(ctx.agents.get(activeAgent.id), activeAgent)
      return activeAgent
    },
    noteFailure(value) { diagnostics.push(value) },
  }
  installChannel(runtime)
  ctx.on('session/flush', session => {
    if (!armed || session !== activeAgent?.session) return
    armed = false
    flushFailures++
    throw new Error(flushFailureText)
  })
  const router = ctx.connection.createSharedFetchHandler('/api')
  const giveBack = async () => {
    const response = await router.fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'browser-give-back', payload: { botId, callId: handoffCallId, outcome: 'done' } }),
    }), ctx.connection.browserPeer)
    assert.equal(response.status, 200)
    return response.json()
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: toolName,
    description: 'Return one browser handoff through the real channel, fail its flush acknowledgement once, and verify that retry does not duplicate the native durable inbox reply.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      assert.equal(ran, false)
      ran = true
      activeAgent = exec.agent
      state.bots[botId] = { id: botId, sessionId: activeAgent.id, name: 'Handoff fixture' }
      browserChannel.setHold(botId, { by: 'bot', reason: 'login', note: 'Synthetic sign-in handoff.', callId: handoffCallId })
      armed = true
      let first
      try { first = await giveBack() }
      finally { armed = false }
      assert.equal(first.ok, false)
      assert.equal(first.error.code, 'bot/handoff-unconfirmed')
      assert.match(first.error.message, /may already be queued; saving is unconfirmed/)
      assert.equal(first.error.stack, undefined)
      assert.equal(first.error.cause, undefined)
      assert.ok(!JSON.stringify(first).includes(flushFailureText))
      assert.equal(diagnostics.length, 1)
      assert.equal(diagnostics[0].source, 'api')
      assert.equal(diagnostics[0].text, `browser-give-back: ${flushFailureText}`)
      assert.equal(diagnostics[0].code, 'Error')
      assert.match(diagnostics[0].stack, /Synthetic handoff flush acknowledgement failure/)
      assert.equal(browserChannel.holdOf(botId), null)
      const retry = await giveBack()
      assert.equal(retry.ok, false)
      assert.equal(retry.error.code, 'bot/forbidden')
      assert.equal(diagnostics.length, 1)
      const queued = activeAgent.inbox.nextTurn.filter(isReply)
      assert.equal(queued.length, 1)
      const reply = JSON.parse(queued[0].content[0].text)
      assert.equal(reply.kind, 'answer_to_pending_handoff')
      assert.equal(reply.callId, handoffCallId)
      assert.equal(reply.outcome, 'done')
      const durable = await persistedEvents(ctx, activeAgent)
      assert.equal(admissions(durable).length, 1)
      assert.equal(flushFailures, 1)
      resultText = JSON.stringify({
        first, retry, holdConsumed: browserChannel.holdOf(botId) === null,
        queuedReplies: queued.length, durableAdmissions: admissions(durable).length, flushFailures,
      })
      return resultText
    },
  })))
  ctx.on('llm/stream', async function* (options, next) {
    assert.ok(options.tools.some(tool => tool.name === toolName))
    const replies = visibleReplies(options.messages)
    if (replies.length > 0) {
      assert.equal(replies.length, 1)
      replyRequestCount++
      assert.equal(replyRequestCount, 1)
      const reply = replies[0]
      assert.equal(reply.kind, 'answer_to_pending_handoff')
      assert.equal(reply.outcome, 'done')
    }
    for (const message of options.messages) {
      if (message.role !== 'tool' || message.toolCallId !== toolCallId) continue
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.equal(text, resultText)
      resultVisible = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    assert.equal(agent, activeAgent)
    completedTurns++
    const events = agent.session.snapshotEvents()
    assert.equal(admissions(events).length, 1)
    assert.equal(resultVisible, true)
    const answer = events.filter(event => event.type === 'assistant/message').at(-1).data.message.content
    if (completedTurns === 1) {
      assert.deepEqual(answer, [{ type: 'text', text: firstAnswer }])
      assert.equal(agent.inbox.nextTurn.filter(isReply).length, 1)
      return
    }
    assert.equal(completedTurns, 2)
    assert.equal(replyRequestCount, 1)
    assert.deepEqual(answer, [{ type: 'text', text: finalAnswer }])
    const durable = await persistedEvents(ctx, agent)
    assert.equal(admissions(durable).length, 1)
    assert.equal(durable.filter(event => event.type === 'user/message' && isReply(event.data)).length, 1)
    assert.equal(agent.inbox.nextTurn.filter(isReply).length, 0)
  })
}
