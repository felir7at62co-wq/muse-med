/**
 * QQ bot in external-consumer mode. A reply answers its message passively while
 * QQ's passive reply window and per-message quota last, then falls back to an
 * active message to the same chat.
 */
import { qqInboundMessage } from './qq-bridge.mjs';
import { isQqMessageAddressed } from './qq-mention.mjs';
import { sendMarkdownReply } from './markdown-reply.mjs';

const MAX_TARGETS = 1_000;
/** QQ accepts passive replies to a message for this long (protocol limits). */
const PASSIVE_WINDOW_MS = Object.freeze({ c2c: 60 * 60_000, group: 5 * 60_000 });
/** Passive replies QQ accepts per inbound message. */
const PASSIVE_REPLIES = Object.freeze({ c2c: 4, group: 5 });

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The normalize/reply pair a QQ runtime hands to its external bridge.
 *
 * @param {object} options
 * @param {object} options.bot - Connected QQ bot client.
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 */
export function qqExternalChannel({ bot, logger = console, now = Date.now }) {
  const targets = new Map();

  const normalize = (message) => {
    const messageId = nonEmptyString(message?.messageId);
    const sender = nonEmptyString(message?.senderId);
    if (!messageId || !sender || message?.senderIsBot === true || !['c2c', 'group'].includes(message?.kind)) return null;
    const group = message.kind === 'group';
    const conversationId = group ? nonEmptyString(message.groupOpenid) : sender;
    if (!conversationId) return null;
    const normalized = qqInboundMessage(message);
    const spoken = (message.attachments ?? [])
      .map((attachment) => nonEmptyString(attachment?.asr_refer_text)).filter(Boolean).join('\n');
    if (message.replyTarget) {
      targets.set(messageId, { replyTarget: message.replyTarget, at: now(), used: 0 });
      if (targets.size > MAX_TARGETS) targets.delete(targets.keys().next().value);
    }
    const name = nonEmptyString(message.senderName);
    const timestamp = Date.parse(message.timestamp ?? '');
    return {
      messageId,
      conversation: { kind: group ? 'group' : 'dm', id: conversationId, ...(!group && name ? { title: name } : {}) },
      actor: { id: sender, ...(name ? { name } : {}) },
      mentionedAccount: isQqMessageAddressed(message),
      text: normalized.content || spoken,
      attachments: [
        ...normalized.images.map((image) => ({ kind: 'image', name: image.name, mediaType: image.mediaType, load: image.load })),
        ...normalized.files.map((file) => ({
          kind: file.mediaType?.startsWith('audio/') ? 'audio' : file.mediaType?.startsWith('video/') ? 'video' : 'file',
          name: file.name, mediaType: file.mediaType, load: file.load,
        })),
      ],
      ...(Number.isFinite(timestamp) ? { at: timestamp } : {}),
      ...(normalized.replyTo?.content ? { quote: { text: normalized.replyTo.content } } : {}),
      reply: { kind: group ? 'group' : 'dm' },
      target: group ? { kind: 'group', route: { groupOpenId: conversationId } } : { kind: 'user', route: { userOpenId: conversationId } },
    };
  };

  const reply = async (route, text, { signal } = {}) => {
    const scope = route.kind === 'group' ? 'group' : 'c2c';
    const held = targets.get(route.messageId);
    const passive = held && now() - held.at < PASSIVE_WINDOW_MS[scope] && held.used < PASSIVE_REPLIES[scope];
    const target = passive ? held.replyTarget : { scope, targetId: route.conversationId };
    const results = await sendMarkdownReply(bot, target, text, { logger, signal, requireComplete: true });
    if (passive) held.used += Math.max(1, results.length);
    return { sent: true };
  };

  return Object.freeze({ normalize, reply });
}
