// Bridge a settled watch through the group to the original requester's inbox.
// Recovery reads receipts and never reruns the worker.
import { SOURCE_KIND } from './constants.js'
import { isGenerationWatchId } from './muse-team.js'

const GROUP_RECEIPTS = 'dsBotGenerationGroupReceipts'
const REQUESTER_RECEIPTS = 'dsBotGenerationRequesterReceipts'
const WORKER_NOTICES = 'jubianGenerationNotices'
const RECOVER_DELAY_MS = 3_000

const groupReceiptOf = source => source?.kind === SOURCE_KIND && source.role === 'post'
  && isGenerationWatchId(source.generationWatch?.noticeId) ? source.generationWatch.noticeId : undefined

const requesterReceiptOf = source => source?.kind === SOURCE_KIND && source.role === 'room'
  && isGenerationWatchId(source.generationWatchReceiptId) ? source.generationWatchReceiptId : undefined

const receiptProjection = (key, receiptOf) => ({
  key,
  stateVersion: 1,
  stateSchema: {
    parse(value) {
      if (!Array.isArray(value) || !value.every(isGenerationWatchId)) throw new Error('Invalid group generation receipts')
      return value
    },
  },
  init: () => [],
  apply(state, event) {
    if (event.type !== 'user/message') return state
    const id = receiptOf(event.data?.source)
    return id === undefined || state.includes(id) ? state : [...state, id]
  },
})

export function installGenerationWatchOutbox(rt, post) {
  const { ctx, state } = rt
  const flights = new Map()
  const outbox = () => state.generationWatchOutbox ??= {}
  const projection = () => ctx.get?.('sessionProjections')
  const register = projections => {
    projections?.register(receiptProjection(GROUP_RECEIPTS, groupReceiptOf))
    projections?.register(receiptProjection(REQUESTER_RECEIPTS, requesterReceiptOf))
  }
  if (typeof ctx.inject === 'function') ctx.inject(['sessionProjections'], scope => { register(scope.sessionProjections) })
  else register(projection())

  const settle = async (session, receiptId) => {
    if (outbox()[receiptId] === undefined) return
    // Keep the outbox until the original requester's claim is on disk.
    if (await ctx.sessions.flush(session) !== true) return
    const record = outbox()[receiptId]
    if (record === undefined) return
    delete outbox()[receiptId]
    try {
      await rt.save({ required: true })
    } catch (error) {
      outbox()[receiptId] ??= record
      throw error
    }
  }

  const claimed = (session, receiptId) => projection()?.stateOf(session, GROUP_RECEIPTS)?.includes(receiptId) === true
  const requesterClaimed = (session, receiptId) => projection()?.stateOf(session, REQUESTER_RECEIPTS)?.includes(receiptId) === true

  async function requesterTook(watch) {
    const { origin, noticeId } = watch
    const requester = await rt.resolveAgent(origin.requesterSessionId)
    if (requesterClaimed(requester.session, noticeId)) {
      await settle(requester.session, noticeId)
      return true
    }
    const pending = [...requester.inbox.nextStep, ...requester.inbox.nextTurn]
      .find(message => requesterReceiptOf(message.source) === noticeId)
    if (pending === undefined) return false
    requester.wakePending?.(pending.id)
    await ctx.sessions.flush(requester.session)
    return true
  }

  const relay = (receiptId, result) => {
    const existing = flights.get(receiptId)
    if (existing !== undefined) return existing
    const work = (async () => {
      const record = outbox()[receiptId]
      if (record === undefined) return
      const { workerSessionId, origin, noticeId, text, logged } = record
      if (rt.museTeam.validateGenerationWatchOrigin(workerSessionId, origin) === undefined) return
      const room = rt.roomOf(origin.roomId)
      const member = rt.botOf(origin.workerBotId)
      if (room === undefined || member === undefined) return
      const watch = { origin, noticeId: receiptId, workerSessionId }
      if (await requesterTook(watch)) return
      if (room.paused?.some(slot => slot.generationWatch?.noticeId === receiptId)) return
      const group = await rt.resolveAgent(room.id)
      const replay = claimed(group.session, receiptId)
      if (result === undefined && !replay) {
        const worker = await rt.resolveAgent(workerSessionId)
        if (projection()?.stateOf(worker.session, WORKER_NOTICES)?.notices?.[noticeId] !== 'settled') return
      }
      if (rt.museTeam.validateGenerationWatchOrigin(workerSessionId, origin) === undefined) return
      await post(room, member, result ?? text, {
        late: true, askedBy: origin.requesterBotId,
        generationWatch: watch,
        ...(replay ? { generationWatchReplay: true } : {}),
        ...(logged === undefined ? {} : { logged }),
      })
    })().finally(() => flights.delete(receiptId))
    flights.set(receiptId, work)
    return work
  }

  const warn = error => rt.warn('ds-bot: generation watch group handoff failed: %s', error)
  const prepare = async ({ workerSessionId, origin, receiptId, noticeId, text }) => {
    const validated = rt.museTeam.validateGenerationWatchOrigin(workerSessionId, origin)
    if (validated === undefined || !isGenerationWatchId(receiptId) || !isGenerationWatchId(noticeId)
      || typeof text !== 'string' || text.trim() === '') return
    const before = outbox()[receiptId]
    if (before?.noticeId === noticeId) return
    const record = { ...before, workerSessionId, origin: validated, noticeId, text: before?.text ?? text }
    outbox()[receiptId] = record
    try {
      await rt.save({ required: true })
    } catch (error) {
      if (outbox()[receiptId] === record) {
        if (before === undefined) delete outbox()[receiptId]
        else outbox()[receiptId] = before
      }
      throw error
    }
  }

  async function recover() {
    await rt.load()
    if (rt.readOnly() !== undefined) return
    for (const receiptId of Object.keys(outbox())) await relay(receiptId).catch(warn)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const receiptId = requesterReceiptOf(event.data?.source)
    if (receiptId === undefined || session?.id !== outbox()[receiptId]?.origin.requesterSessionId) return
    void settle(session, receiptId).catch(warn)
  })
  ctx.effect(() => {
    const timer = setTimeout(() => void recover().catch(warn), RECOVER_DELAY_MS)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'ds-bot: recover generation result handoffs')

  const logged = (receiptId, seq) => {
    const record = outbox()[receiptId]
    if (record !== undefined && seq !== undefined) record.logged = seq
    return record?.logged
  }

  return { prepare, relay, claimed, requesterTook, logged, has: id => outbox()[id] !== undefined }
}
