/**
 * External-consumer mode for the channels on the shared text bridge (Telegram,
 * Discord, Slack, WhatsApp, Matrix, iMessage, Email). Their runtimes already
 * normalize platform messages into the text-bridge message; this turns that
 * message into a channel-neutral one and answers through the channel's bot
 * client, with Markdown where the client renders it.
 */
import { createTextDeliveryBlock } from './semantic/delivery.mjs';

const MAX_ROUTES = 1_000;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The proactive delivery target for the conversation a text-bridge message came from. */
const TARGETS = Object.freeze({
  telegram: ({ replyTarget: route }) => {
    if (route?.chatId === undefined || route.chatId === null) return undefined;
    const chatId = String(route.chatId);
    return Number.isSafeInteger(route.messageThreadId) && route.messageThreadId > 0
      ? { kind: 'topic', route: { chatId, messageThreadId: route.messageThreadId } }
      : { kind: 'chat', route: { chatId } };
  },
  discord: ({ replyTarget: route }) => (nonEmptyString(route?.channelId)
    ? { kind: 'channel', route: { channelId: route.channelId } } : undefined),
  slack: ({ replyTarget: route, kind }) => {
    if (!nonEmptyString(route?.channelId)) return undefined;
    return kind === 'group' && nonEmptyString(route.threadTs)
      ? { kind: 'thread', route: { channelId: route.channelId, threadTs: route.threadTs } }
      : { kind: 'conversation', route: { channelId: route.channelId } };
  },
  whatsapp: ({ replyTarget: route }) => {
    const jid = nonEmptyString(route?.jid);
    return jid ? { kind: jid.endsWith('@g.us') ? 'group' : 'user', route: { jid } } : undefined;
  },
  matrix: ({ replyTarget: route }) => {
    if (!nonEmptyString(route?.roomId)) return undefined;
    return nonEmptyString(route.threadId)
      ? { kind: 'thread', route: { roomId: route.roomId, threadId: route.threadId } }
      : { kind: 'room', route: { roomId: route.roomId } };
  },
  imessage: ({ replyTarget: route }) => (nonEmptyString(route?.chatGuid)
    ? { kind: 'user', route: { chatGuid: route.chatGuid } } : undefined),
  email: ({ replyTarget: route }) => {
    const address = nonEmptyString(route?.to)?.match(/[^\s<>]+@[^\s<>]+/u)?.[0];
    return address ? { kind: 'user', route: { address: address.toLowerCase() } } : undefined;
  },
});

/**
 * The normalize/reply/proactive triple a text-bridge runtime hands to its external bridge.
 *
 * @param {object} options
 * @param {string} options.channel - dsh-im channel id.
 * @param {object} options.bot - The channel's bot client (`sendText`, optional `sendDelivery`).
 */
export function textExternalChannel({ channel, bot }) {
  if (!bot || typeof bot.sendText !== 'function') throw new TypeError('A bot client is required');
  const routes = new Map();

  const send = async (target, text, { signal, format = 'plain' } = {}) => {
    signal?.throwIfAborted();
    if (format === 'markdown' && typeof bot.sendDelivery === 'function') {
      return bot.sendDelivery(target, createTextDeliveryBlock(text, format));
    }
    return bot.sendText(target, text);
  };

  const normalize = (message) => {
    const messageId = nonEmptyString(message?.messageId);
    const senderId = nonEmptyString(message?.senderId);
    const conversationId = nonEmptyString(message?.conversationId);
    if (!messageId || !senderId || !conversationId || message.senderIsBot === true || !message.replyTarget) return null;
    const group = message.kind === 'group';
    routes.set(messageId, message.replyTarget);
    if (routes.size > MAX_ROUTES) routes.delete(routes.keys().next().value);
    let source = {};
    try { source = message.contextSource?.() ?? {}; }
    catch { /* A missing display name leaves the sender's id. */ }
    const name = nonEmptyString(source.senderName) ?? nonEmptyString(message.senderName);
    const title = nonEmptyString(source.conversationTitle) ?? (group ? null : name);
    let target;
    try { target = TARGETS[channel]?.(message); }
    catch { target = undefined; }
    return {
      messageId,
      conversation: { kind: group ? 'group' : 'dm', id: conversationId, ...(title ? { title } : {}) },
      actor: { id: senderId, ...(name ? { name } : {}) },
      mentionedAccount: !group || message.addressed === true,
      text: typeof message.content === 'string' ? message.content.trim() : '',
      attachments: [
        ...(Array.isArray(message.images) ? message.images : []).filter(Boolean)
          .map((image, index) => ({ kind: 'image', name: image.name ?? (index === 0 ? 'image' : `image-${index + 1}`), mediaType: image.mediaType, load: image.load })),
        ...(Array.isArray(message.files) ? message.files : []).filter(Boolean)
          .map((file) => ({ kind: 'file', name: file.name, mediaType: file.mediaType, load: file.load })),
      ],
      ...(nonEmptyString(message.replyTo?.content) ? { quote: { text: message.replyTo.content } } : {}),
      reply: { kind: group ? 'group' : 'dm' },
      ...(target ? { target } : {}),
    };
  };

  const reply = async (route, text, options = {}) => {
    const target = routes.get(route.messageId);
    if (!target) throw Object.assign(new Error('stale-route'), { code: 'stale-route' });
    await send(target, text, options);
    return { sent: true };
  };

  return Object.freeze({ normalize, reply, proactive: send });
}
