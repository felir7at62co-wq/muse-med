import {
  ExclusiveInboundConsumers,
  ExternalInboundBridge,
  ExternalModeStore,
  externalAccountFingerprint,
  externalInboundEvent,
} from '../../src/channels/shared/external-consumer.mjs';

/** What a channel-neutral consumer can rely on for a bot in external-consumer mode. */
export const EXTERNAL_CONSUMER_CAPABILITIES = Object.freeze([
  'exclusive-text-consumer',
  'reply-text-checked',
  'proactive-text-checked',
  'history-text-checked',
  'inbound-attachments',
  'channel-neutral-consumer',
]);

function refusal(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function bytesOf(result) {
  if (Buffer.isBuffer(result) || result instanceof Uint8Array) return Buffer.from(result);
  const raw = result?.data ?? result?.buffer;
  return Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw) : null;
}

/**
 * Hand one channel's bots to an external consumer (Muse's DS Bot).
 *
 * The host owns the persisted mode, the consumer registry and the live
 * external bridges. A channel runtime asks {@link runtimeHook} for its bridge
 * when the bot is external; the delivery adapter routes `consumeInbound`,
 * `replyChecked`, `historyChecked` and `describeAccount` here.
 *
 * @param {object} options
 * @param {string} options.channel - dsh-im channel id.
 * @param {ExternalModeStore} options.modeStore - Loaded mode store.
 * @param {(botId: string) => ({ name?: string } | null | undefined)} options.account - Configured bot, or null when unknown.
 * @param {(botId: string) => Promise<unknown>} options.reconnect - Restart the bot's runtime so it picks up its mode.
 * @param {number} [options.consumerWaitMs] - How long an inbound message waits for a consumer to register.
 * @param {Array<'plain'|'markdown'>} [options.formats] - Reply text formats the platform renders.
 * @param {object} [options.logger]
 */
export function createExternalConsumerHost({ channel, modeStore, account, reconnect, consumerWaitMs = 60_000, formats = ['plain', 'markdown'], logger = console }) {
  if (!(modeStore instanceof ExternalModeStore)) throw new TypeError('An external mode store is required');
  if (typeof account !== 'function' || typeof reconnect !== 'function') throw new TypeError('account and reconnect are required');
  if (!Number.isSafeInteger(consumerWaitMs) || consumerWaitMs < 0) throw new TypeError('consumerWaitMs must be a non-negative integer');
  const consumers = new ExclusiveInboundConsumers();
  const bridges = new Map();
  const waiters = new Map();

  const fingerprintOf = (botId) => externalAccountFingerprint(channel, botId);
  const known = (botId) => {
    const info = account(botId);
    if (!info) throw refusal('unknown-bot', 'Unknown bot');
    return info;
  };
  const checked = (botId, expectedFingerprint) => {
    known(botId);
    if (expectedFingerprint !== fingerprintOf(botId)) throw refusal('account-changed');
  };
  const wake = (botId) => {
    for (const resolve of waiters.get(botId) ?? []) resolve();
    waiters.delete(botId);
  };
  const waitForConsumer = async (botId, signal) => {
    if (consumers.has(botId)) return;
    if (consumerWaitMs === 0) throw refusal('consumer-unavailable');
    signal?.throwIfAborted();
    let resolve;
    let reject;
    const ready = new Promise((done, fail) => { resolve = done; reject = fail; });
    const timer = setTimeout(() => reject(refusal('consumer-unavailable')), consumerWaitMs);
    timer.unref?.();
    const abort = () => reject(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const set = waiters.get(botId) ?? new Set();
    set.add(resolve);
    waiters.set(botId, set);
    try {
      await ready;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      set.delete(resolve);
      if (set.size === 0 && waiters.get(botId) === set) waiters.delete(botId);
    }
  };

  const deliver = async (botId, message, signal) => {
    const loaders = (Array.isArray(message.attachments) ? message.attachments : []).map((item) => item?.load);
    const event = externalInboundEvent({ channel, botId, fingerprint: fingerprintOf(botId), message });
    if (!event) return;
    await waitForConsumer(botId, signal);
    await consumers.accept(botId, event, signal, undefined, (deliverySignal) => ({
      async loadAttachment(index, { signal: loadSignal, maxBytes } = {}) {
        const load = loaders[index];
        if (!Number.isInteger(index) || typeof load !== 'function') throw refusal('attachment-unavailable');
        const combined = loadSignal ? AbortSignal.any([loadSignal, deliverySignal]) : deliverySignal;
        combined.throwIfAborted();
        const result = await load({ signal: combined, ...(maxBytes === undefined ? {} : { maxBytes }) });
        combined.throwIfAborted();
        const data = bytesOf(result);
        if (!data) throw refusal('attachment-unavailable');
        if (Number.isFinite(maxBytes) && data.length > maxBytes) throw refusal('attachment-too-large');
        const described = event.attachments[index];
        return {
          kind: described.kind,
          data,
          ...(typeof result?.name === 'string' && result.name ? { name: result.name } : described.name ? { name: described.name } : {}),
          ...(typeof result?.mediaType === 'string' ? { mediaType: result.mediaType } : described.mediaType ? { mediaType: described.mediaType } : {}),
        };
      },
    }));
  };

  return Object.freeze({
    channel,
    isExternal: (botId) => modeStore.has(botId),

    /**
     * The bridge factory a runtime uses while its bot is external, or undefined when it is not.
     * @param {string} botId
     */
    runtimeHook(botId) {
      if (!modeStore.has(botId)) return undefined;
      return Object.freeze({
        createBridge({ normalize, reply, proactive, status, logger: runtimeLogger = logger, signal }) {
          const bridge = new ExternalInboundBridge({
            channel, normalize, reply, proactive, status, logger: runtimeLogger, signal,
            deliver: (message) => deliver(botId, message, signal),
          });
          bridges.set(botId, { bridge, status, signal });
          signal?.addEventListener('abort', () => {
            if (bridges.get(botId)?.bridge === bridge) bridges.delete(botId);
          }, { once: true });
          return bridge;
        },
      });
    },

    async describeDeliveryAccount(botId) {
      const info = known(botId);
      const live = bridges.get(botId);
      return {
        version: 1,
        botId,
        channel,
        account: { fingerprint: fingerprintOf(botId), ...(info.name ? { name: info.name } : {}) },
        mode: modeStore.has(botId) ? 'external-consumer' : 'standalone',
        connected: live !== undefined && !live.signal?.aborted && live.status?.ready === true,
        formats: [...formats],
        capabilities: [...EXTERNAL_CONSUMER_CAPABILITIES],
      };
    },

    async consumeInbound(botId, { expectedFingerprint, onEvent, signal } = {}) {
      checked(botId, expectedFingerprint);
      signal?.throwIfAborted();
      const dispose = consumers.register(botId, { fingerprint: expectedFingerprint, onEvent, signal });
      try {
        await modeStore.set(botId, true);
        signal?.throwIfAborted();
        if (!bridges.has(botId)) {
          // A bot that cannot connect now stays external; its supervisor retries
          // and the next runtime starts with the external bridge.
          await Promise.resolve(reconnect(botId)).catch((error) => {
            logger.warn?.(`[dsh-im:${channel}] bot ${botId} is handed to Muse but not connected yet (${error?.code ?? error?.name ?? 'error'})`);
          });
        }
        signal?.throwIfAborted();
        wake(botId);
        return dispose;
      } catch (error) {
        dispose();
        throw error;
      }
    },

    async replyChecked(botId, route, text, { expectedFingerprint, signal, format = 'plain' } = {}) {
      checked(botId, expectedFingerprint);
      consumers.signalFor(botId, expectedFingerprint);
      const live = bridges.get(botId);
      if (!live || live.signal?.aborted) throw refusal('bot-not-connected');
      if (!route || typeof route.conversationId !== 'string' || typeof route.messageId !== 'string') throw refusal('bad-request');
      signal?.throwIfAborted();
      const result = await live.bridge.reply(route, text, { signal, format });
      return { sent: true, ...(typeof result?.messageId === 'string' && result.messageId ? { messageId: result.messageId } : {}) };
    },

    async historyChecked(botId, route, query = {}, { expectedFingerprint } = {}) {
      checked(botId, expectedFingerprint);
      consumers.signalFor(botId, expectedFingerprint);
      const live = bridges.get(botId);
      if (!live || live.signal?.aborted) throw refusal('bot-not-connected');
      const limit = query.limit === undefined ? 20 : query.limit;
      if (!route || typeof route.conversationId !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw refusal('bad-request');
      const events = live.bridge.history(route.conversationId, limit);
      return { version: 1, scope: query.scope ?? 'group', events, omitted: 0, hasMore: false, coverage: 'seen-since-connect' };
    },

    /** Note a proactive send in the conversation's history. */
    rememberSent(botId, conversationId, text) {
      bridges.get(botId)?.bridge.rememberSent(conversationId, text);
    },

    close() {
      consumers.close();
      for (const botId of [...waiters.keys()]) wake(botId);
      bridges.clear();
    },
  });
}

/**
 * Load the mode store and build the host for one channel's production wiring.
 *
 * @param {object} options - {@link createExternalConsumerHost} options with `path` instead of `modeStore`.
 * @param {string} options.path - JSON file that records the bots handed to a consumer.
 */
export async function loadExternalConsumerHost({ path, ...options }) {
  const modeStore = await new ExternalModeStore(path).load();
  return createExternalConsumerHost({ ...options, modeStore });
}
