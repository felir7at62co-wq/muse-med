function refusal(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
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
    || (message?.message_type !== 'text' && (!rich || !['image', 'audio'].includes(message?.message_type)))) return null;
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
  try { content = JSON.parse(message.content); } catch { throw refusal('invalid-inbound'); }
  const imageKey = rich && message.message_type === 'image' ? identifier(content?.image_key) : undefined;
  const audioKey = rich && message.message_type === 'audio' ? identifier(content?.file_key) : undefined;
  const text = message.message_type === 'text' ? content?.text : '';
  if (typeof text !== 'string' || (!imageKey && !audioKey && !text.trim()) || text.length > 16000) throw refusal('invalid-inbound');
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
    ...(imageKey ? { imageKey } : {}),
    ...(audioKey ? { audioKey } : {}),
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

export class ExclusiveInboundConsumers {
  #entries = new Map();

  register(botId, { fingerprint, onEvent, signal, rich = false }) {
    if (this.#entries.has(botId)) throw refusal('consumer-conflict');
    if (!/^[a-f0-9]{64}$/.test(fingerprint ?? '') || typeof onEvent !== 'function')
      throw refusal('bad-request');
    signal?.throwIfAborted();
    const controller = new AbortController();
    const entry = { fingerprint, onEvent, controller, rich, dispose: undefined };
    const dispose = () => {
      if (this.#entries.get(botId) === entry) this.#entries.delete(botId);
      controller.abort(refusal('consumer-unavailable'));
      signal?.removeEventListener('abort', dispose);
    };
    entry.dispose = dispose;
    this.#entries.set(botId, entry);
    signal?.addEventListener('abort', dispose, { once: true });
    return dispose;
  }

  async accept(botId, evidence, signal, voiceForRoute) {
    const entry = this.#entries.get(botId);
    if (!entry) throw refusal('consumer-unavailable');
    if (entry.fingerprint !== evidence.fingerprint) throw refusal('account-changed');
    const deliverySignal = signal
      ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal;
    deliverySignal.throwIfAborted();
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(deliverySignal.reason);
      deliverySignal.addEventListener('abort', abort, { once: true });
      if (deliverySignal.aborted) abort();
    });
    let result;
    try {
      result = await Promise.race([entry.onEvent(evidence, { signal: deliverySignal, ...(voiceForRoute ? { voice: voiceForRoute(deliverySignal) } : {}) }), interrupted]);
    } finally {
      deliverySignal.removeEventListener('abort', abort);
    }
    deliverySignal.throwIfAborted();
    if (this.#entries.get(botId) !== entry) throw refusal('consumer-unavailable');
    if (result?.accepted !== true) throw refusal('ingress-not-accepted');
    return { accepted: true };
  }

  signalFor(botId, fingerprint) {
    const entry = this.#entries.get(botId);
    if (!entry) throw refusal('consumer-unavailable');
    if (entry.fingerprint !== fingerprint) throw refusal('account-changed');
    return entry.controller.signal;
  }

  acceptsRich(botId, fingerprint) {
    this.signalFor(botId, fingerprint);
    return this.#entries.get(botId).rich;
  }

  remove(botId) {
    const entry = this.#entries.get(botId);
    entry?.dispose();
  }

  close() {
    for (const botId of this.#entries.keys()) this.remove(botId);
  }
}
