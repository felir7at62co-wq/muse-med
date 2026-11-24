function refusal(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

// Message types whose one file a rich consumer downloads by key.
const FILE_TYPES = new Set(['file', 'media']);
const MESSAGE_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

/** A rich-text post as Lark sends it: a title and paragraphs, possibly under a locale key. */
function postOf(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return undefined;
  const body = Array.isArray(content.content) ? content
    : Object.values(content).find(part => Array.isArray(part?.content));
  if (!body) return undefined;
  return Object.freeze(structuredClone({
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    content: body.content.filter(Array.isArray),
  }));
}

export function normalizeExternalText(event, { botId, appId, botOpenId, fingerprint, rich = false, groupResponseMode, stepPushMode }) {
  const message = event?.message;
  const actorId = identifier(event?.sender?.sender_id?.open_id);
  const messageId = identifier(message?.message_id);
  const conversationId = identifier(message?.chat_id);
  const eventId = identifier(event?.event_id ?? event?.header?.event_id);
  const eventApp = event?.app_id ?? event?.header?.app_id;
  if (eventApp !== undefined && eventApp !== appId) throw refusal('account-changed');
  if (event?.sender?.sender_type === 'app' || event?.sender?.sender_type === 'bot') return null;
  if (event?.sender?.sender_type !== 'user'
    || !['p2p', 'group'].includes(message?.chat_type)
    || (message?.message_type !== 'text' && !rich)) return null;
  // A rich consumer also takes what it cannot read, so it can tell the person.
  const messageType = message.message_type;
  if (typeof messageType !== 'string' || !MESSAGE_TYPE.test(messageType)) throw refusal('invalid-inbound');
  if (message.chat_type === 'group' && !identifier(botOpenId)) throw refusal('account-unverified');
  if (message.mentions !== undefined && (!Array.isArray(message.mentions) || message.mentions.length > 100))
    throw refusal('invalid-inbound');
  const mentions = Object.freeze((message.mentions ?? []).map(mention => {
    const id = identifier(mention?.id?.open_id ?? mention?.open_id);
    const key = identifier(mention?.key);
    if (!id || !key) throw refusal('invalid-inbound');
    return Object.freeze({ id, key, ...(identifier(mention.name) ? { name: mention.name } : {}) });
  }));
  if (!actorId || !messageId || !conversationId || !eventId
    || !/^[a-f0-9]{64}$/.test(fingerprint ?? '')) throw refusal('invalid-inbound');
  let content;
  try { content = JSON.parse(message.content); } catch {
    // A forwarded bundle's content is a bare sentence, not JSON.
    if (!rich || messageType === 'text') throw refusal('invalid-inbound');
    content = {};
  }
  const imageKey = rich && messageType === 'image' ? identifier(content?.image_key) : undefined;
  const audioKey = rich && messageType === 'audio' ? identifier(content?.file_key) : undefined;
  const fileKey = rich && FILE_TYPES.has(messageType) ? identifier(content?.file_key) : undefined;
  const fileName = fileKey && typeof content?.file_name === 'string' && content.file_name.trim()
    ? content.file_name.trim().slice(0, 255) : undefined;
  const post = rich && messageType === 'post' ? postOf(content) : undefined;
  const text = messageType === 'text' ? content?.text : '';
  if (typeof text !== 'string' || text.length > 16000 || (!rich && !text.trim())) throw refusal('invalid-inbound');
  const milliseconds = Number(message.create_time);
  const timestamp = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || !Number.isFinite(timestamp.getTime()))
    throw refusal('invalid-inbound');
  const route = Object.freeze({
    messageId, conversationId, actorId,
    ...(identifier(message.thread_id) ? { threadId: message.thread_id } : {}),
    ...(identifier(message.root_id) ? { rootId: message.root_id } : {}),
    ...(identifier(message.parent_id) ? { parentId: message.parent_id } : {}),
  });
  return Object.freeze({
    version: 1, channel: 'feishu', botId, fingerprint, eventId, messageId,
    actor: Object.freeze({ kind: 'user', id: actorId,
      ...(identifier(event.sender.sender_name) ? { name: event.sender.sender_name } : {}) }),
    conversation: Object.freeze({ kind: message.chat_type === 'group' ? 'group' : 'dm', id: conversationId }),
    mentions, mentionedAccount: mentions.some(mention => mention.id === botOpenId),
    at: timestamp.toISOString(), text, reply: route,
    ...(rich ? { messageType } : {}),
    ...(imageKey ? { imageKey } : {}),
    ...(audioKey ? { audioKey } : {}),
    ...(fileKey ? { fileKey } : {}),
    ...(fileName ? { fileName } : {}),
    ...(post ? { post } : {}),
    ...(rich && stepPushMode ? { stepPushMode } : {}),
    ...(rich && groupResponseMode === 'all' ? { groupResponseMode: 'all' } : {}),
    replay: Object.freeze({ kind: 'provider-redelivery', resumeCursor: false, gapPossible: true }),
  });
}

/** Map a Bot button callback received by the authenticated Feishu connection. */
export function normalizeExternalCard(event, { botId, appId, fingerprint }) {
  const eventApp = event?.app_id ?? event?.header?.app_id;
  if (eventApp !== undefined && eventApp !== appId) throw refusal('account-changed');
  const actorId = identifier(event.operator?.open_id ?? event.operator?.operator_id?.open_id);
  const conversationId = identifier(event.context?.open_chat_id ?? event.message?.chat_id);
  const messageId = identifier(event.context?.open_message_id ?? event.message_id);
  const value = event.action?.value?.v;
  if (!actorId || !conversationId || !messageId || typeof value !== 'string' || !value || value.length > 2048) return null;
  return Object.freeze({ version: 1, channel: 'feishu', botId, fingerprint, messageId,
    kind: 'card', actorId, conversationId, value });
}

// The consumer registry is channel-neutral; Feishu keeps its historical import path.
export { ExclusiveInboundConsumers } from '../shared/external-consumer.mjs';
