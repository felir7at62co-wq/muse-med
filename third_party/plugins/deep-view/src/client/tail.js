// The turn tail: under the turn's closing message, each successful show_view
// call draws its card — display-only from the call arguments, the live card
// while the host's pending record names the call, the settled card once the
// user's answer message is in the chat. A dismissed or superseded card and a
// refused call draw nothing.
import { createElement as h, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { checkShownView } from '../core/views.js'
import { WidgetCard } from '../react/card.js'
import { useViewUi } from '../react/ui.js'
import { call } from './api.js'

const REPLY_HEAD = '{"kind":"answer_to_pending_view"'

// The text of the user message that answered `callId`, or undefined. The reply
// names the call at its top level, so the scan stays a cheap string check until
// a candidate parses.
const findReplyText = (snapshot, callId) => {
  const chat = snapshot?.views?.get?.('chat')
  if (chat === undefined) return undefined
  const needle = `"callId":"${callId}"`
  for (const node of chat.nodes?.values?.() ?? []) {
    const data = node?.data
    const text = typeof data?.text === 'string' ? data.text
      : Array.isArray(data?.content) ? data.content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
      : undefined
    if (typeof text === 'string' && text.startsWith(REPLY_HEAD) && text.includes(needle)) return text
  }
  return undefined
}

// The settled card for a view the user already answered: the reply message
// carries the blueprint and the answer, so it draws without the pending store.
const SettledView = ({ replyText }) => {
  let payload = null
  try { payload = JSON.parse(replyText) } catch { payload = null }
  const view = payload?.views?.[0]
  if (view === undefined || view?.view === undefined) return null
  const answers = Array.isArray(payload.answers) ? payload.answers : []
  const answer = answers.find(entry => entry?.id === view.id) ?? answers[0] ?? null
  return h('div', { className: 'dv-q-inline' }, h(WidgetCard, { title: view.title ?? '', view: view.view, settled: true, answer }))
}

// The live card while the host waits for the answer. It re-reads the pending
// record when the chat gains nodes — a user message admitted into the session
// revokes the card on the host — and after its own submit or dismiss, never on
// a streamed chunk: the gate is the chat node count, a coarse value.
const InteractiveView = ({ callId, sessionId, useConversation }) => {
  const ui = useViewUi()
  const order = useConversation?.(snapshot => snapshot?.views?.get?.('chat')?.order?.length ?? 0) ?? 0
  const replyText = useConversation?.(snapshot => findReplyText(snapshot, callId))
  const [record, setRecord] = useState(undefined)
  const [revision, setRevision] = useState(0)
  const [flying, setFlying] = useState(false)
  const [verified, setVerified] = useState(false)
  const [error, setError] = useState(null)
  const [answer, setAnswer] = useState(undefined)
  const operation = useRef(null)
  useEffect(() => {
    const owner = { controller: new AbortController(), busy: false }
    operation.current = owner
    return () => { owner.controller.abort(); operation.current = null }
  }, [])
  useEffect(() => {
    if (typeof sessionId !== 'string' || replyText !== undefined) return undefined
    const controller = new AbortController()
    setVerified(false)
    call('pending', { sessionId }, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setRecord(value)
      setVerified(true)
      setError(null)
    }).catch(() => {
      if (!controller.signal.aborted) setError('Could not load this view. Refresh its status to try again.')
    })
    return () => { controller.abort() }
  }, [sessionId, order, replyText, revision])
  if (replyText !== undefined) return h(SettledView, { replyText })
  if (flying === 'gone' || record === null || (record !== undefined && record.callId !== callId)) return null
  const run = (op, payload) => {
    const owner = operation.current
    if (owner === null || owner.busy || !verified || record.answerPending === true || answer !== undefined) return
    owner.busy = true
    setFlying(true)
    setError(null)
    void call(op, payload, owner.controller.signal).then(() => {
      if (owner.controller.signal.aborted) return
      if (op === 'reply') setAnswer({ id: record.id, action: payload.action, values: payload.values })
      else setFlying('gone')
    }).catch(() => {
      if (owner.controller.signal.aborted) return
      setVerified(false)
      setError(op === 'reply'
        ? 'Could not confirm this answer. Refresh the view status before trying again.'
        : 'Could not close this view. Refresh its status to try again.')
    }).finally(() => {
      owner.busy = false
      if (!owner.controller.signal.aborted) setFlying(value => value === 'gone' ? value : false)
    })
  }
  const onSubmit = (action, values) => run('reply', { sessionId, viewId: record.id, action, values })
  const onDismiss = () => run('dismiss', { sessionId, viewId: record.id })
  const pending = record?.answerPending === true
  return h('div', { className: 'dv-q-inline' },
    record === undefined ? null : h(WidgetCard, { title: record.title ?? '', view: record.view,
      onSubmit: answer === undefined ? onSubmit : undefined, onDismiss: answer === undefined ? onDismiss : undefined,
      settled: answer !== undefined, answer, busy: flying === true || !verified || pending }),
    error !== null || pending ? h('div', { className: 'dv-view-callout', 'data-tone': 'warn', role: error === null ? 'status' : 'alert' },
      h('div', { className: 'dv-view-callout-text' }, ui.t(error ?? 'An answer is awaiting confirmation. Refresh its status; do not submit a different answer.')),
      h('button', { type: 'button', className: 'dv-q-btn', disabled: flying === true,
        onClick: () => setRevision(value => value + 1) }, ui.t('Refresh status'))) : null)
}

const TailView = ({ call, sessionId, useConversation }) => {
  const shown = checkShownView(call.args?.title, call.args?.view)
  if (shown.error !== undefined) return null
  // The same refusal rules the tool applied: a call that showed no card draws none.
  if (!shown.interactive && call.args?.await_reply === true) return null
  if (shown.interactive && call.args?.await_reply === false) return null
  if (shown.interactive || call.args?.await_reply === true) {
    return h(InteractiveView, { callId: call.callId, sessionId, useConversation })
  }
  return h('div', { className: 'dv-q-inline' }, h(WidgetCard, { title: shown.title, view: shown.view }))
}

export function ViewsTail({ turn, sessionId, useConversation }) {
  const source = useMemo(() => turn?.data?.source?.('deep-view-views'), [turn])
  const data = useSyncExternalStore(source?.subscribe ?? (() => () => {}), () => source?.getSnapshot())
  const views = data?.views ?? []
  if (views.length === 0) return null
  return views.map(item => h(TailView, { key: `${sessionId}:${item.callId}`, call: item, sessionId, useConversation }))
}
