/**
 * WeCom self-built application (callback mode) in external-consumer mode. The
 * app receives private messages from members; replies use the message/send API.
 */
import { wecomAppInboundMessage } from './wecom-app-bridge.mjs';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The normalize/reply pair a WeCom app runtime hands to its external bridge.
 *
 * @param {object} options
 * @param {object} options.api - Authenticated WecomAppApi.
 * @param {(target: object, text: string, options: object) => Promise<unknown>} options.sendText - The runtime's text send.
 */
export function wecomAppExternalChannel({ api, sendText }) {
  const normalize = (message) => {
    const messageId = nonEmptyString(message?.msgid);
    const sender = nonEmptyString(message?.from?.userid);
    if (!messageId || !sender || !['text', 'image'].includes(message?.msgtype)) return null;
    const normalized = wecomAppInboundMessage(message, api);
    const created = Number(message?.createTime ?? message?.create_time);
    return {
      messageId,
      conversation: { kind: 'dm', id: sender },
      actor: { id: sender },
      mentionedAccount: true,
      text: normalized.content ?? '',
      attachments: normalized.images.map((image, index) => ({ kind: 'image', name: index === 0 ? 'image' : `image-${index + 1}`, load: image.load })),
      ...(Number.isFinite(created) && created > 0 ? { at: created < 10_000_000_000 ? created * 1_000 : created } : {}),
      reply: { kind: 'dm' },
      target: { kind: 'user', route: { chatId: sender } },
    };
  };

  const reply = async (route, text, { signal } = {}) => {
    await sendText({ kind: 'user', route: { chatId: route.conversationId } }, text, { signal });
    return { sent: true };
  };

  return Object.freeze({ normalize, reply });
}
