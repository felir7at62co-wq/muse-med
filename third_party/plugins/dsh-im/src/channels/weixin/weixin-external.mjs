/**
 * WeChat (iLink bot) in external-consumer mode. iLink delivers private chats
 * only; every reply is a tracked send to the person with their latest
 * conversation context token.
 */
import { weixinInboundMessage } from './weixin-bridge.mjs';
import { weixinMessageId, weixinMessageTimestampMs } from './weixin-api.mjs';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The normalize/reply pair a WeChat runtime hands to its external bridge.
 *
 * @param {object} options
 * @param {object} options.api - iLink API client.
 * @param {object} options.state - The bot's state store (context tokens).
 * @param {(target: object, text: string, options: object) => Promise<unknown>} options.sendText - The runtime's tracked text send.
 * @param {object} [options.logger]
 */
export function weixinExternalChannel({ api, state, sendText, logger = console }) {
  const normalize = async (message) => {
    // Type 2 is the bot's own outbound message echoed by the update stream.
    if (message?.message_type === 2) return null;
    const messageId = weixinMessageId(message);
    const sender = nonEmptyString(message?.from_user_id);
    if (!messageId || !sender) return null;
    const contextToken = nonEmptyString(message?.context_token);
    const at = message?.create_time_ms ?? weixinMessageTimestampMs(messageId);
    if (contextToken) {
      // Replies and later sends need the person's newest context token.
      await Promise.resolve(state?.rememberContextToken?.({ userId: sender, contextToken, seq: message.seq, messageTimeMs: at }))
        .catch(() => logger.warn?.('[dsh-weixin] failed to persist conversation context'));
    }
    const normalized = weixinInboundMessage(message, api, state);
    return {
      messageId,
      conversation: { kind: 'dm', id: sender },
      actor: { id: sender },
      mentionedAccount: true,
      text: normalized.content ?? '',
      attachments: [
        ...normalized.images.map((image) => ({ kind: 'image', name: image.name, load: image.load })),
        ...normalized.files.map((file) => ({ kind: 'file', name: file.name, load: file.load })),
      ],
      ...(Number.isFinite(Number(at)) && Number(at) > 0 ? { at: Number(at) } : {}),
      ...(normalized.replyTo?.content ? { quote: { text: normalized.replyTo.content } } : {}),
      reply: { kind: 'dm' },
      target: { kind: 'user', route: { toUserId: sender } },
    };
  };

  const reply = async (route, text, { signal } = {}) => {
    // WeChat shows plain text: the consumer sends text without Markdown.
    await sendText({ kind: 'user', route: { toUserId: route.conversationId } }, text, { signal, format: 'plain' });
    return { sent: true };
  };

  return Object.freeze({ normalize, reply });
}
