/**
 * DingTalk in external-consumer mode: Stream callbacks become channel-neutral
 * messages; replies go to the message's session webhook while it is valid and
 * through the robot API after that.
 */
import { dingtalkInboundMessage } from './dingtalk-bridge.mjs';
import { normalizeDingtalkSessionWebhook, splitDingtalkText } from './dingtalk-api.mjs';

const MAX_ROUTES = 1_000;
/** Leave this much of a webhook's lifetime unused, so a reply never races its expiry. */
const WEBHOOK_MARGIN_MS = 60_000;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsedContent(message) {
  if (message?.content && typeof message.content === 'object') return message.content;
  if (typeof message?.content !== 'string') return null;
  try {
    const parsed = JSON.parse(message.content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function timestamp(value) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.trunc(number < 10_000_000_000 ? number * 1_000 : number);
}

/** A short notification title for a Markdown reply. */
export function markdownTitle(text) {
  const line = String(text ?? '').split('\n').map((item) => item.replace(/[#>*_`~[\]()|-]/g, '').trim()).find(Boolean) ?? '';
  return (line || 'Muse').slice(0, 30);
}

/**
 * The normalize/reply pair a DingTalk runtime hands to its external bridge.
 *
 * @param {object} options
 * @param {object} options.api - DingTalk API client.
 * @param {string} options.clientId
 * @param {string} options.clientSecret
 * @param {number} [options.maxMessageChars]
 * @param {() => number} [options.now]
 */
export function dingtalkExternalChannel({ api, clientId, clientSecret, maxMessageChars = 4_000, now = Date.now }) {
  // Webhooks carry an access token: they stay here, keyed by message, and never
  // reach the consumer's reply route.
  const webhooks = new Map();
  const remember = (messageId, value) => {
    webhooks.set(messageId, value);
    if (webhooks.size > MAX_ROUTES) webhooks.delete(webhooks.keys().next().value);
  };

  const normalize = (message) => {
    const messageId = nonEmptyString(message?.msgId);
    const sender = nonEmptyString(message?.senderStaffId) ?? nonEmptyString(message?.senderId);
    const group = String(message?.conversationType) === '2';
    const conversationId = group ? nonEmptyString(message?.conversationId) : sender;
    if (!messageId || !sender || !conversationId || (!group && String(message?.conversationType) !== '1')) return null;
    const robotCode = nonEmptyString(message?.robotCode) ?? clientId;
    const normalized = dingtalkInboundMessage(message, { api, clientId, clientSecret });
    const msgtype = String(message?.msgtype ?? '').toLowerCase();
    const content = parsedContent(message) ?? {};
    let text = nonEmptyString(normalized.content) ?? '';
    const attachments = [
      ...normalized.images.map((image) => ({ kind: 'image', name: image.name, load: image.load })),
      ...normalized.files.map((file) => ({ kind: 'file', name: file.name, load: file.load })),
    ];
    if (msgtype === 'audio' || msgtype === 'voice') {
      // DingTalk transcribes voice messages itself; the recording stays available too.
      text = nonEmptyString(content.recognition) ?? text;
      const code = nonEmptyString(content.downloadCode);
      if (code) attachments.push({ kind: 'audio', name: 'voice', load: ({ signal } = {}) => api.downloadFile({ clientId, clientSecret, robotCode, downloadCode: code, signal }) });
    } else if (msgtype === 'video') {
      const code = nonEmptyString(content.downloadCode);
      if (code) attachments.push({ kind: 'video', name: 'video', load: ({ signal } = {}) => api.downloadFile({ clientId, clientSecret, robotCode, downloadCode: code, signal }) });
    }
    let webhook = null;
    try { webhook = normalizeDingtalkSessionWebhook(message.sessionWebhook); }
    catch { /* No safe webhook: replies use the robot API. */ }
    if (webhook) remember(messageId, { webhook, expiresAt: timestamp(message.sessionWebhookExpiredTime) });
    const name = nonEmptyString(message?.senderNick);
    return {
      messageId,
      conversation: { kind: group ? 'group' : 'dm', id: conversationId,
        ...(group ? (nonEmptyString(message?.conversationTitle) ? { title: message.conversationTitle } : {}) : (name ? { title: name } : {})) },
      actor: { id: sender, ...(name ? { name } : {}) },
      mentionedAccount: !group || message?.isInAtList === true,
      text,
      attachments,
      at: timestamp(message?.createAt),
      ...(normalized.replyTo?.content ? { quote: { text: normalized.replyTo.content, ...(normalized.replyTo.authorName ? { author: normalized.replyTo.authorName } : {}) } } : {}),
      reply: { kind: group ? 'group' : 'dm', senderId: sender, robotCode },
      target: group
        ? { kind: 'group', route: { openConversationId: conversationId } }
        : { kind: 'user', route: { userId: sender } },
    };
  };

  const reply = async (route, text, { signal, format = 'plain' } = {}) => {
    const held = webhooks.get(route.messageId);
    const markdown = format === 'markdown';
    const fresh = held && (held.expiresAt === undefined || held.expiresAt - WEBHOOK_MARGIN_MS > now());
    if (fresh) {
      const at = route.kind === 'group' && route.senderId ? { atUserIds: [route.senderId] } : undefined;
      for (const chunk of splitDingtalkText(text, maxMessageChars)) {
        signal?.throwIfAborted();
        await api.sendText({ clientId, clientSecret, sessionWebhook: held.webhook, text: chunk, at, signal,
          ...(markdown ? { markdownTitle: markdownTitle(chunk) } : {}) });
      }
      return { sent: true };
    }
    // The webhook expired: a late answer goes to the same chat through the robot API.
    await api.sendRobotText({
      clientId,
      clientSecret,
      target: route.kind === 'group'
        ? { type: 'group', robotCode: route.robotCode ?? clientId, openConversationId: route.conversationId }
        : { type: 'user', robotCode: route.robotCode ?? clientId, userId: route.senderId ?? route.conversationId },
      text,
      format: markdown ? 'markdown' : 'plain',
      signal,
    });
    return { sent: true };
  };

  return Object.freeze({ normalize, reply });
}
