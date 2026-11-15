// Deep View's tool and owner-authenticated card answers. The last answer identity
// is retained so an uncertain flush cannot admit a second answer.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkShownView, validateViewAnswer } from '../core/views.js'
import { showViewParameters, showViewDescription } from '../core/tool-schema.js'
import { REPLY_SOURCE_KIND, viewReply } from '../core/reply.js'
import { createPendingStore } from './pending.js'

export const ROUTE = '/api/deep-view'
const output = {
  schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }],
  presentationMeta: () => ({ owner: 'deep-view' }),
}
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const ok = value => ({ ok: true, value })
const fail = (message, code = 'deep-view/error') => ({ ok: false, error: { code, message, details: {} } })
const errorOf = (code, message) => Object.assign(new Error(message), { code })
const humanSource = kind => kind === 'user' || kind === 'user-question-reply' || kind === REPLY_SOURCE_KIND
function hasMessage(agent, id) {
  if ([...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.id === id)) return true
  return agent.session.deriveMessages().some(message => message.id === id)
}

/**
 * Register the view tool and owner-authenticated answer route.
 * @param ctx Host context with tools, Connection, Sessions and the live Agent registry.
 * @param config Optional private data directory.
 */
export function install(ctx, config = {}) {
  const home = config.home ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'deep-view')
  const pending = createPendingStore(home), work = new Set(), sessions = new Map(), revisions = new Map()
  let stopping = false
  const assertRunning = signal => {
    if (stopping) throw errorOf('deep-view/unavailable', 'The view service is stopping. Check the card after reconnecting.')
    signal?.throwIfAborted()
  }
  const track = run => {
    if (stopping) return Promise.reject(errorOf('deep-view/unavailable', 'The view service is stopping.'))
    const task = Promise.resolve().then(run)
    work.add(task)
    task.then(() => work.delete(task), () => work.delete(task))
    return task
  }
  const inSession = (id, run) => {
    const task = (sessions.get(id) ?? Promise.resolve()).catch(() => {}).then(run)
    sessions.set(id, task)
    const release = () => { if (sessions.get(id) === task) sessions.delete(id) }
    task.then(release, release)
    return task
  }
  const assertCurrent = (id, revision) => {
    if ((revisions.get(id) ?? 0) !== revision) throw errorOf('deep-view/stale', 'This view was superseded by a newer message.')
  }
  const assertLiveRoot = agent => {
    if (agent === undefined || ctx.agents.get(agent.id) !== agent || !ctx.agents.roots().includes(agent)) {
      throw errorOf('deep-view/root-required', 'A view that waits for the user only works in a root session; include the unanswered question or decision in your final result.')
    }
  }
  ctx.effect(() => async () => {
    stopping = true
    await Promise.allSettled([...work])
    await pending.close()
  }, 'deep-view: pending operations')

  ctx.tools.register(defineTool({
    name: 'show_view',
    description: showViewDescription({ where: 'the chat', placement: 'It appears under your reply for this turn.' }),
    parameters: showViewParameters, output,
    async execute(args, exec) {
      const checked = checkShownView(args.title, args.view)
      if (checked.error !== undefined) return checked.error
      if (!checked.interactive && args.await_reply === true) return 'This view has nothing to submit; call show_view with await_reply: false.'
      if (checked.interactive && args.await_reply === false) return 'This view has controls to submit, so it waits for the user\'s answer; call show_view without await_reply: false.'
      assertRunning(exec.signal)
      if (!(args.await_reply ?? checked.interactive)) return 'The view is on screen.'
      try { assertLiveRoot(exec.agent) } catch (error) { return error.message }
      if (typeof exec.callId !== 'string' || exec.callId === '') return 'This view cannot wait for the user without a tool-call identity.'
      const id = exec.agent.session.id
      return track(() => inSession(id, async () => {
        assertRunning(exec.signal)
        assertLiveRoot(exec.agent)
        const revision = revisions.get(id) ?? 0
        try {
          await pending.set(id, { id: exec.callId, callId: exec.callId, title: checked.title, view: checked.view,
            askedAt: Date.now(), afterSeq: exec.agent.session.seq - 1 })
        } catch (error) {
          ctx.logger?.warn('deep-view: pending view could not be saved (%s)', error?.code ?? 'write-failed')
          return 'The view could not be kept open for an answer. Check the view service before trying again.'
        }
        try { assertRunning(exec.signal); assertLiveRoot(exec.agent); assertCurrent(id, revision) } catch (error) {
          await pending.drop(id, exec.callId)
          throw error
        }
        exec.concludeTurn()
        return 'The view is on screen; the user\'s answer arrives as their next message.'
      }))
    },
  }))

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' || !humanSource(event.data.source.kind)) return
    revisions.set(session.id, (revisions.get(session.id) ?? 0) + 1)
    void track(() => inSession(session.id, async () => {
      await pending.load()
      const record = pending.get(session.id)
      if (record === undefined || event.seq <= (record.afterSeq ?? -1)) return
      if (record.delivery?.message.id === event.data.id) return
      if (record.delivery === undefined) await pending.drop(session.id, record.id)
      else if (record.closed !== true) await pending.set(session.id, { ...record, closed: true })
    })).catch(error => { ctx.logger?.warn('deep-view: card revocation was not saved (%s)', error?.code ?? 'write-failed') })
  })

  const answer = async (id, record, body, signal) => {
    const revision = revisions.get(id) ?? 0
    const values = validateViewAnswer(record.view, body.action, body.values)
    if (values.error !== undefined) return fail(values.error, 'deep-view/invalid')
    if (record.delivery !== undefined && (record.delivery.action !== body.action || JSON.stringify(record.delivery.values) !== JSON.stringify(values))) {
      return fail('This card already has a different answer. Check the existing answer before continuing.', 'deep-view/answer-conflict')
    }
    assertRunning(signal)
    const resolved = await ctx.sessionController.resolveAgent(id)
    assertRunning(signal)
    if (resolved.agent === undefined) return fail('The conversation is unavailable. Reopen it before answering.', 'deep-view/unavailable')
    const agent = resolved.agent
    assertLiveRoot(agent)
    if (record.delivery === undefined) assertCurrent(id, revision)
    let claimed = record
    if (record.delivery === undefined) {
      const reply = viewReply(record, body.action, values, REPLY_SOURCE_KIND)
      const message = createUserMessage({ content: [{ type: 'text', text: reply.text }], source: reply.source })
      claimed = { ...record, delivery: { action: body.action, values, message, delivered: false } }
      await pending.set(id, claimed)
      try { assertRunning(signal); assertLiveRoot(agent); assertCurrent(id, revision) } catch (error) { await pending.set(id, record); throw error }
      // The intent precedes admission. Once attempted, a thrown admission or
      // failed flush cannot authorize a new message identity.
      try { agent.followup(freezeMessage(message)) } catch (error) {
        ctx.logger?.warn('deep-view: answer admission outcome is uncertain (%s)', error?.code ?? 'admission-failed')
        return fail('The answer may already be queued. Check this card and conversation before continuing.', 'deep-view/unconfirmed')
      }
    } else if (!hasMessage(agent, record.delivery.message.id)) {
      return fail('The earlier answer outcome is uncertain. Check the conversation before continuing; do not submit another answer.', 'deep-view/unconfirmed')
    }
    try {
      await ctx.sessions.flush(agent.session)
      await pending.set(id, { ...claimed, delivery: { ...claimed.delivery, delivered: true } })
    } catch (error) {
      ctx.logger?.warn('deep-view: answer durability is uncertain (%s)', error?.code ?? 'flush-failed')
      return fail('The answer may already be queued. Refresh its status; do not submit another answer.', 'deep-view/unconfirmed')
    }
    return ok(true)
  }
  const handle = (op, body, signal) => track(async () => {
    const id = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
    if (id === undefined) return op === 'pending' ? ok(null) : fail('No conversation was selected', 'deep-view/invalid')
    return inSession(id, async () => {
      assertRunning(signal)
      await pending.load()
      assertRunning(signal)
      const record = pending.get(id)
      if (op === 'pending') {
        if (record === undefined || record.closed === true || record.delivery?.delivered === true) return ok(null)
        const { delivery, ...visible } = record
        return ok({ ...visible, ...(delivery === undefined ? {} : { answerPending: true }) })
      }
      if (op !== 'dismiss' && op !== 'reply') return fail('Unknown view operation', 'deep-view/not-found')
      if (record === undefined || typeof body.viewId !== 'string' || record.id !== body.viewId) return fail('This view is no longer open', 'deep-view/stale')
      if (op === 'dismiss') {
        if (record.delivery === undefined) await pending.drop(id, body.viewId)
        else await pending.set(id, { ...record, closed: true })
        return ok(true)
      }
      return answer(id, record, body, signal)
    })
  })
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      let result
      try {
        const body = await request.json()
        result = await handle(String(body?.op ?? ''), isRecord(body) ? body : {}, request.signal)
      } catch (error) {
        const code = typeof error?.code === 'string' && error.code.startsWith('deep-view/') ? error.code : 'deep-view/internal'
        result = fail(code === 'deep-view/internal' ? 'The view could not be read or saved. Check its status before trying again.' : error.message, code)
      }
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }), 'deep-view: api route')
}
