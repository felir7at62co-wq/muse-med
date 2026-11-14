// Private pending views and answer intents. A failed replacement retains the last
// committed in-memory state; callers can retry without resurrecting removed cards.
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { checkShownView } from '../core/views.js'
import { REPLY_SOURCE_KIND, viewReply } from '../core/reply.js'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function validateRecord(record) {
  if (!isRecord(record) || typeof record.id !== 'string' || record.id === ''
    || typeof record.title !== 'string' || !Number.isFinite(record.askedAt)
    || (record.callId !== undefined && (typeof record.callId !== 'string' || record.callId === ''))
    || (record.afterSeq !== undefined && (!Number.isSafeInteger(record.afterSeq) || record.afterSeq < -1))
    || (record.closed !== undefined && record.closed !== true)) {
    throw new Error('deep-view: invalid pending view')
  }
  const checked = checkShownView(record.title, record.view)
  if (checked.error !== undefined || !checked.interactive) throw new Error('deep-view: invalid pending blueprint')
  if (record.delivery === undefined) return
  const delivery = record.delivery
  if (!isRecord(delivery) || !isRecord(delivery.message) || typeof delivery.message.id !== 'string'
    || delivery.message.id === '' || delivery.message.role !== 'user' || typeof delivery.delivered !== 'boolean') throw new Error('deep-view: invalid answer intent')
  const reply = viewReply(record, delivery.action, delivery.values, REPLY_SOURCE_KIND)
  if (reply === undefined || delivery.message.content?.length !== 1
    || delivery.message.content[0]?.type !== 'text' || delivery.message.content[0]?.text !== reply.text
    || !isRecord(delivery.message.source) || delivery.message.source.kind !== reply.source.kind
    || delivery.message.source.callId !== reply.source.callId || delivery.message.source.outcome !== reply.source.outcome) throw new Error('deep-view: invalid answer intent')
}

/**
 * Create a single-writer store whose mutations commit after an atomic file replacement.
 * First load creates the private directory; a file ancestor is an error.
 * @param home Private directory holding pending.json.
 * @returns Detached reads, serialized writes and an asynchronous drain operation.
 */
export function createPendingStore(home) {
  const path = join(home, 'pending.json')
  let views = null
  let loading
  let writing = Promise.resolve()
  let closing = false

  const load = async () => {
    if (views !== null) return
    if (loading === undefined) {
      loading = (async () => {
        await mkdir(home, { recursive: true, mode: 0o700 })
        let text
        try { text = await readFile(path, 'utf8') } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          views = new Map()
          return
        }
        const data = JSON.parse(text)
        if (!isRecord(data)) throw new Error('deep-view: invalid pending file')
        for (const [sessionId, record] of Object.entries(data)) {
          if (sessionId === '') throw new Error('deep-view: invalid pending session')
          validateRecord(record)
        }
        views = new Map(Object.entries(data))
      })().catch(error => { loading = undefined; throw error })
    }
    await loading
  }

  const mutate = change => {
    if (closing) return Promise.reject(new Error('deep-view: pending store is closed'))
    const run = writing.then(async () => {
      await load()
      const next = new Map(views)
      if (!change(next)) return false
      await writeFileAtomic(path, JSON.stringify(Object.fromEntries(next)), { mode: 0o600, dirMode: 0o700 })
      views = next
      return true
    })
    writing = run.catch(() => {})
    return run
  }

  return {
    load,
    get: sessionId => {
      const record = views?.get(sessionId)
      return record === undefined ? undefined : structuredClone(record)
    },
    set: (sessionId, record) => {
      validateRecord(record)
      const saved = structuredClone(record)
      return mutate(next => { next.set(sessionId, saved); return true })
    },
    drop: (sessionId, viewId) => mutate(next => {
      const record = next.get(sessionId)
      if (record === undefined || (viewId !== undefined && record.id !== viewId)) return false
      return next.delete(sessionId)
    }),
    snapshot: () => structuredClone(Object.fromEntries(views ?? [])),
    close: async () => { closing = true; await writing; await loading },
  }
}
