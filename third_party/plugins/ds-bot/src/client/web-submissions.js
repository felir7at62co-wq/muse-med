import { t } from './i18n.js'

const PREFIX = 'muse-bot.web-submission.v1:'
const REFUSED = new Set(['bot/invalid', 'bot/refused', 'bot/read-only', 'bot/not-found', 'bot/submission-conflict', 'HTTP_400', 'HTTP_401', 'HTTP_403', 'HTTP_413'])
const pendingError = cause => Object.assign(new Error(t('Could not confirm this message. Reconnect and send it again to check its receipt.')), { code: 'bot/submission-unknown', cause })
const storageError = cause => Object.assign(new Error(t('Could not save the send receipt. Your message has not been sent.')), { code: 'bot/submission-storage', cause })
const receiptStatus = (value, requestId) => {
  if (value?.clientRequestId !== requestId || !['accepted', 'missing', 'unknown'].includes(value.status)
    || value.accepted !== (value.status === 'accepted')) throw pendingError()
  return value.status
}

/**
 * Submit each browser message with a persisted identity, reconciling uncertain delivery before a manual retry.
 * @param {Function} call Existing authenticated Bot request carrier.
 * @param {object} options Optional storage, crypto and installation scope used by the browser or a test.
 * @returns {Function} Text submission operation; an unknown receipt never authorizes another delivery.
 */
export function createWebTaskSender(call, options = {}) {
  const active = new Map()
  const crypto = options.crypto ?? globalThis.crypto
  const scope = options.scope ?? globalThis.location?.pathname.match(/^\/desktop\/[^/]+\//)?.[0] ?? '/'
  const storageOf = () => options.storage ?? globalThis.localStorage

  async function submit(identity, text, targetSessionId = identity) {
    const content = text.trim()
    const pendingKey = JSON.stringify([identity, content])
    if (active.has(pendingKey)) return active.get(pendingKey)

    const operation = (async () => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pendingKey))
      const fingerprint = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
      const key = PREFIX + encodeURIComponent(scope) + ':' + fingerprint
      let storage, record
      try {
        storage = storageOf()
        const saved = storage.getItem(key)
        record = saved === null ? null : JSON.parse(saved)
        if (record !== null && (typeof record !== 'object' || Array.isArray(record)
          || typeof record.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.clientRequestId)
          || typeof record.sessionId !== 'string' || record.sessionId === '')) {
          throw new Error('Invalid saved submission identity')
        }
      } catch (error) { throw storageError(error) }

      const accepted = result => {
        // Retaining a receipt after a storage failure is safer than reissuing an accepted task.
        try { storage.removeItem(key) } catch (error) { void error /* The next attempt reconciles the retained identity. */ }
        return result
      }
      if (record !== null) {
        let status
        try { status = await call('submission', { sessionId: record.sessionId, text: content, clientRequestId: record.clientRequestId }) }
        catch (error) { throw pendingError(error) }
        const state = receiptStatus(status, record.clientRequestId)
        if (state === 'accepted') return accepted(status)
        if (state !== 'missing') throw pendingError()
      } else {
        record = { clientRequestId: crypto.randomUUID(), sessionId: targetSessionId }
        try { storage.setItem(key, JSON.stringify(record)) }
        catch (error) { throw storageError(error) }
      }

      const payload = { sessionId: record.sessionId, text: content, clientRequestId: record.clientRequestId }
      let result
      try { result = await call('send', payload) }
      catch (error) {
        if (REFUSED.has(error?.code)) throw error
        try { result = await call('submission', payload) }
        catch { throw pendingError(error) }
        if (receiptStatus(result, record.clientRequestId) !== 'accepted') throw pendingError(error)
      }
      if (receiptStatus(result, record.clientRequestId) !== 'accepted') throw pendingError()
      return accepted(result)
    })()
    active.set(pendingKey, operation)
    try { return await operation } finally { active.delete(pendingKey) }
  }
  return submit
}
