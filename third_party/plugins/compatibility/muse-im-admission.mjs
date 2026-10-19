/** Preserve imported message deduplication and direct Sessions after native authorization. */
import { join } from 'node:path'
import { createInboundClaims } from './muse-feishu-reliability.mjs'
import { bindMuseImDirectSession } from './muse-im-migration.mjs'

/**
 * Check exact bot mentions and durable claims only after the native access policy allows a message.
 * Imported sender and chat lists never override the saved native access settings.
 * @param {object} config Resolved legacy configuration and claim limits.
 * @param {object} migration Imported identity and non-secret sender policy.
 * @returns {object} Per-bot callbacks used by the native Feishu bridge.
 */
export function createMuseImAdmission(config, migration) {
  if (!migration?.botId) return { forBot: () => undefined }
  const policy = migration.legacyPolicy ?? migration
  const oldMessages = new Set(policy.legacyMessageIds ?? [])
  const claims = createInboundClaims(migration.claimsPath ?? join(config.dshHome, 'integrations', 'dsh-feishu', 'muse-inbound-claims.json'), {
    retentionMs: config.inboundClaimRetentionMs,
    maxEntries: config.inboundClaimMaxEntries,
  })
  const admission = workspaces => ({
    async message(event, state) {
      const message = event?.message
      const sender = event?.sender?.sender_id?.open_id
      const id = message?.message_id
      if (typeof sender !== 'string' || typeof id !== 'string' || !id) return false
      if (message.chat_type === 'group') {
        if (typeof message.chat_id !== 'string' || !/^oc_[A-Za-z0-9_-]+$/u.test(message.chat_id)) return false
        const botOpenId = migration.botOpenId ?? policy.botOpenId
        if (!botOpenId || !message.mentions?.some(mention => (mention?.id?.open_id ?? mention?.open_id) === botOpenId)) return false
      } else if (message.chat_type !== 'p2p') return false
      if (oldMessages.has(id) || state.hasSeen(id) || !claims.claim(id)) return false
      if (message.chat_type === 'p2p') await bindMuseImDirectSession(config, {
        chatId: message.chat_id, senderOpenId: sender,
      }, state, workspaces)
      return true
    },
  })
  return { forBot: (botId, workspaces) => botId === migration.botId ? admission(workspaces) : undefined }
}
