// Browser prompt receipts share the team's durable request ledger and native Session inbox.
const requestError = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })

function inputOf(body) {
  if (typeof body.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.clientRequestId)) {
    throw requestError('The message request identifier is invalid.')
  }
  if (typeof body.sessionId !== 'string' || body.sessionId === '' || typeof body.text !== 'string' || body.text.trim() === '') {
    throw requestError('Nothing to send')
  }
  return { clientRequestId: body.clientRequestId, sessionId: body.sessionId, text: body.text.trim() }
}

const conflict = () => requestError('This message request identifier was already used for different content.', 'bot/submission-conflict')
const receipt = (input, status, sessionId) => ({
  accepted: status === 'accepted', status, clientRequestId: input.clientRequestId,
  ...(sessionId === undefined ? {} : { sessionId }),
})

/**
 * Keep browser retries tied to one durable prompt admission.
 * @param {object} rt Native Bot runtime with the existing request ledger.
 * @param {(sessionId: string) => string} targetOf Resolve a Bot or retained chat part to its current Session.
 * @returns {{send: Function, lookup: Function}} Submission and receipt operations; neither replays an uncertain admission.
 */
export function createWebSubmissions(rt, targetOf) {
  const requestOf = input => rt.requestIdentity({
    caller: 'muse-web', context: 'prompt', name: input.clientRequestId,
    payload: { sessionId: input.sessionId, text: input.text },
  })
  const nativeId = input => `muse-web:${input.clientRequestId}`

  // A Host may exit after the Session flush and before the team receipt settles.
  // Only the exact native rpcId and text establish that such an admission succeeded.
  async function nativeReceipt(input) {
    const current = targetOf(input.sessionId)
    const candidates = [...new Set([input.sessionId, current])]
    for (const sessionId of candidates) {
      // A retained part can keep its events after its Agent is disposed.
      const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
      const messages = [...(agent?.inbox.nextStep ?? []), ...(agent?.inbox.nextTurn ?? [])]
      for (const message of messages) {
        if (message.source?.kind !== 'user' || message.source.rpcId !== nativeId(input)) continue
        if (message.content.length !== 1 || message.content[0].type !== 'text' || message.content[0].text !== input.text) throw conflict()
        await rt.ctx.sessions.flush(agent.session)
        return receipt(input, 'accepted', sessionId)
      }
      try {
        for await (const event of rt.eventsBackwards(sessionId, AbortSignal.timeout(5_000))) {
          if (event.type !== 'user/message' || event.data.source?.kind !== 'user' || event.data.source.rpcId !== nativeId(input)) continue
          const content = event.data.content
          if (content.length !== 1 || content[0].type !== 'text' || content[0].text !== input.text) throw conflict()
          return receipt(input, 'accepted', sessionId)
        }
      } catch (error) {
        if (error?.code === 'bot/submission-conflict') throw error
        // Unavailable history does not establish rejection or authorize a second delivery.
      }
    }
    return receipt(input, 'unknown')
  }

  async function fromVerdict(input, known) {
    if (known === undefined) return receipt(input, 'missing')
    if (known.status === 'conflict') throw conflict()
    if (known.status === 'sent' || known.status === 'replay') return known.receipt
    return nativeReceipt(input)
  }

  return {
    async lookup(body) {
      const input = inputOf(body)
      return fromVerdict(input, await rt.knownRequest(requestOf(input)))
    },
    async send(body) {
      const input = inputOf(body)
      const request = requestOf(input)
      const known = await rt.knownRequest(request)
      if (known !== undefined) return fromVerdict(input, known)
      const admitted = await rt.admitRequest(request, async () => {
        const sessionId = targetOf(input.sessionId)
        await rt.ensureCapabilities(sessionId)
        const response = await rt.ctx.sessionController.prompt({
          requestId: nativeId(input), sessionId, mode: 'queue', content: [{ type: 'text', text: input.text }],
        }, AbortSignal.timeout(30_000))
        if (response.accepted !== true) throw requestError('The computer has not confirmed this message.', 'bot/submission-unknown')
        const agent = await rt.resolveAgent(sessionId)
        await rt.ctx.sessions.flush(agent.session)
        return receipt(input, 'accepted', sessionId)
      })
      return fromVerdict(input, admitted)
    },
  }
}
