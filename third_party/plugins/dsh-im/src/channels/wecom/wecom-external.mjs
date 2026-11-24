/**
 * WeCom intelligent bot (aibot WebSocket) in external-consumer mode. A reply
 * answers its message frame while the passive reply window is open and is
 * sent into the chat after that.
 */
import { generateReqId } from '@wecom/aibot-node-sdk';
import { wecomInboundMessage } from './wecom-bridge.mjs';
import { chunkMarkdownText } from '../shared/markdown-chunks.mjs';

const MAX_FRAMES = 500;
/** WeCom accepts a passive (stream) reply to a message frame for a limited time. */
const PASSIVE_REPLY_WINDOW_MS = 5 * 60_000;
/** WeCom Markdown messages carry at most 20,480 UTF-8 bytes; three bytes per UTF-16 unit stays under it. */
const MARKDOWN_CHUNK = 6_000;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The normalize/reply pair a WeCom runtime hands to its external bridge.
 *
 * @param {object} options
 * @param {object} options.client - Connected aibot WSClient.
 * @param {() => number} [options.now]
 * @param {(prefix: string) => string} [options.newReqId]
 */
export function wecomExternalChannel({ client, now = Date.now, newReqId = generateReqId }) {
  const frames = new Map();

  const normalize = (frame) => {
    const body = frame?.body && typeof frame.body === 'object' ? frame.body : {};
    const messageId = nonEmptyString(body.msgid);
    const senderId = nonEmptyString(body.from?.userid);
    const group = body.chattype === 'group';
    const chatId = group ? nonEmptyString(body.chatid) : senderId;
    if (!messageId || !senderId || !chatId || !['single', 'group'].includes(body.chattype)) return null;
    const message = wecomInboundMessage(frame, client);
    frames.set(messageId, { frame, at: now(), replied: false });
    if (frames.size > MAX_FRAMES) frames.delete(frames.keys().next().value);
    return {
      messageId,
      conversation: { kind: group ? 'group' : 'dm', id: chatId },
      actor: { id: senderId },
      // The bot receives group messages only when it is mentioned.
      mentionedAccount: true,
      text: message.content ?? '',
      attachments: [
        ...message.images.map((image, index) => ({ kind: 'image', name: index === 0 ? 'image' : `image-${index + 1}`, load: image.load })),
        ...message.files.map((file) => ({ kind: 'file', name: file.name, load: file.load })),
      ],
      ...(message.replyTo?.content ? { quote: { text: message.replyTo.content } } : {}),
      reply: { kind: group ? 'group' : 'dm' },
      target: { kind: group ? 'group' : 'user', route: { chatId } },
    };
  };

  const sendInChat = async (chatId, content) => {
    await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content } });
  };

  const reply = async (route, text, { signal } = {}) => {
    const chunks = chunkMarkdownText(text, MARKDOWN_CHUNK);
    const held = frames.get(route.messageId);
    let rest = chunks;
    if (held && !held.replied && now() - held.at < PASSIVE_REPLY_WINDOW_MS && chunks.length > 0) {
      held.replied = true;
      signal?.throwIfAborted();
      try {
        await client.replyStream(held.frame, newReqId('stream'), chunks[0], true);
        rest = chunks.slice(1);
      } catch {
        // The frame's reply window closed early: the chat still gets the message.
        rest = chunks;
      }
    }
    for (const chunk of rest) {
      signal?.throwIfAborted();
      await sendInChat(route.conversationId, chunk);
    }
    return { sent: true };
  };

  return Object.freeze({ normalize, reply });
}
