/** Admit the migrated bot's owner in new groups and preserve durable message deduplication. */
import { join } from 'node:path'
import { createInboundClaims } from './muse-feishu-reliability.mjs'
import { bindMuseImDirectSession } from './muse-im-migration.mjs'

/**
 * Keep legacy group access and admit the registered owner in new groups after an exact bot mention.
 * Native channel policies still apply; newly configured bots have no migration callback.
 * @param {object} config Resolved legacy configuration and claim limits.
 * @param {object} migration Imported identity and non-secret sender policy.
 * @returns {object} Per-bot callbacks used by the native Feishu bridge.
 */
export function createMuseImAdmission(config, migration) {
  if (!migration?.botId) return { forBot: () => undefined }
  const policy = migration.legacyPolicy ?? migration
  const allowedChats = new Set(policy.allowedChatIds ?? [])
  const allowedDirect = new Set(policy.allowedDirectIds ?? policy.ownerOpenIds ?? [])
  const owners = new Set(policy.ownerOpenIds ?? [])
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
        if (!allowedChats.has(message.chat_id) && !owners.has(sender)) return false
        const botOpenId = migration.botOpenId ?? policy.botOpenId
        if (!botOpenId || !message.mentions?.some(mention => (mention?.id?.open_id ?? mention?.open_id) === botOpenId)) return false
      } else if (message.chat_type === 'p2p') {
        if (!allowedDirect.has(sender)) return false
      } else return false
      if (oldMessages.has(id) || state.hasSeen(id) || !claims.claim(id)) return false
      if (message.chat_type === 'p2p') await bindMuseImDirectSession(config, {
        chatId: message.chat_id, senderOpenId: sender,
      }, state, workspaces)
      return true
    },
    action(event) {
      const operator = event?.operator?.open_id ?? event?.operator?.operator_id?.open_id ?? event?.open_id
      return owners.has(operator)
    },
  })
  return { forBot: (botId, workspaces) => botId === migration.botId ? admission(workspaces) : undefined }
}
