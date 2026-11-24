/**
 * Channel-neutral external consumers.
 *
 * A bot in external-consumer mode keeps its platform connection in dsh-im but
 * hands every inbound message to one registered consumer (Muse's DS Bot)
 * instead of a DSH Session. The consumer owns chat bindings, access and
 * prompts; dsh-im owns the account, the wire, attachments and replies.
 *
 * Inbound events are version 1 records with the same top-level fields as the
 * Feishu external event (`actor`, `conversation`, `mentions`,
 * `mentionedAccount`, `text`, `reply`), plus `attachments` (metadata only; the
 * bytes load through the delivery context) and an optional `target` for
 * proactive sends to the same conversation.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const EXTERNAL_EVENT_VERSION = 1;
export const EXTERNAL_CONSUMER_MODE = 'external-consumer';
/** Longest inbound text an event carries; longer text is cut at this length. */
export const MAX_EXTERNAL_TEXT = 16_000;
const MAX_ATTACHMENTS = 20;
const MAX_HISTORY_PER_CONVERSATION = 50;
const MAX_CONVERSATIONS = 200;
const MAX_SEEN = 4_096;
const ATTACHMENT_KINDS = new Set(['image', 'file', 'audio', 'video']);
const ROUTE_VALUE_LENGTH = 2_048;

function refusal(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

function label(value) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 200) : undefined;
}

/** Copy a reply route: a flat record of short strings, numbers and booleans. */
function routeCopy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refusal('invalid-inbound');
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)) throw refusal('invalid-inbound');
    if (typeof item === 'string' ? item.length > ROUTE_VALUE_LENGTH
      : !(typeof item === 'boolean' || Number.isFinite(item))) throw refusal('invalid-inbound');
    out[key] = item;
  }
  return Object.freeze(out);
}

/** The stable account digest a consumer pins: the provider and its account-derived bot id. */
export function externalAccountFingerprint(channel, botId) {
  return createHash('sha256').update(JSON.stringify({ provider: channel, botId })).digest('hex');
}

/**
 * Build one frozen inbound event from a channel-normalized message.
 *
 * @param {object} input
 * @param {string} input.channel - dsh-im channel id.
 * @param {string} input.botId - dsh-im bot id.
 * @param {string} input.fingerprint - Account fingerprint from {@link externalAccountFingerprint}.
 * @param {object} input.message - Channel-normalized message: `messageId`, `conversation`
 *   `{ kind: 'dm'|'group', id, title? }`, `actor` `{ id, name? }`, `text`, `mentionedAccount`,
 *   `attachments` `[{ kind, name?, mediaType? }]`, `reply` route, optional `target`, `at`, `quote`.
 * @returns {Readonly<object>} The version 1 event.
 */
export function externalInboundEvent({ channel, botId, fingerprint, message }) {
  const messageId = identifier(message?.messageId);
  const conversationId = identifier(message?.conversation?.id);
  const actorId = identifier(message?.actor?.id);
  const kind = message?.conversation?.kind;
  if (!messageId || !conversationId || !actorId || !['dm', 'group'].includes(kind)
    || !/^[a-f0-9]{64}$/.test(fingerprint ?? '')) throw refusal('invalid-inbound');
  const raw = typeof message.text === 'string' ? message.text : '';
  const text = raw.length > MAX_EXTERNAL_TEXT ? raw.slice(0, MAX_EXTERNAL_TEXT) : raw;
  const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
    .slice(0, MAX_ATTACHMENTS)
    .map((item) => {
      if (!ATTACHMENT_KINDS.has(item?.kind)) throw refusal('invalid-inbound');
      return Object.freeze({
        kind: item.kind,
        ...(label(item.name) ? { name: label(item.name) } : {}),
        ...(identifier(item.mediaType) ? { mediaType: item.mediaType } : {}),
      });
    });
  if (!text.trim() && attachments.length === 0) return null;
  const at = message.at === undefined ? Date.now() : new Date(message.at).getTime();
  if (!Number.isFinite(at) || at <= 0) throw refusal('invalid-inbound');
  const actorName = label(message.actor.name);
  const title = label(message.conversation.title);
  const quoteText = typeof message.quote?.text === 'string' ? message.quote.text.slice(0, 4_000).trim() : '';
  const quoteAuthor = label(message.quote?.author);
  return Object.freeze({
    version: EXTERNAL_EVENT_VERSION,
    channel,
    botId,
    fingerprint,
    eventId: identifier(message.eventId) ?? `${channel}:${messageId}`,
    messageId,
    actor: Object.freeze({ kind: 'user', id: actorId, ...(actorName ? { name: actorName } : {}) }),
    conversation: Object.freeze({ kind, id: conversationId, ...(title ? { title } : {}) }),
    mentions: Object.freeze([]),
    mentionedAccount: message.mentionedAccount === true || kind === 'dm',
    at: new Date(at).toISOString(),
    text,
    attachments: Object.freeze(attachments),
    ...(quoteText || quoteAuthor ? { quote: Object.freeze({ ...(quoteText ? { text: quoteText } : {}), ...(quoteAuthor ? { author: quoteAuthor } : {}) }) } : {}),
    reply: routeCopy({ ...message.reply, messageId, conversationId }),
    ...(message.target ? { target: Object.freeze({ kind: message.target.kind, route: routeCopy(message.target.route) }) } : {}),
    replay: Object.freeze({ kind: 'provider-redelivery', resumeCursor: false, gapPossible: true }),
  });
}

/** One registered consumer per bot; a second registration is a conflict. */
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

  has(botId) {
    return this.#entries.has(botId);
  }

  /**
   * Hand one event to the bot's consumer and wait for its decision.
   *
   * @param {string} botId
   * @param {object} evidence - The inbound event.
   * @param {AbortSignal} [signal]
   * @param {(signal: AbortSignal) => object} [voiceForRoute] - Adds `voice` to the context (Feishu).
   * @param {(signal: AbortSignal) => object} [contextFor] - Adds further context fields.
   * @returns {Promise<{accepted: true}>}
   */
  async accept(botId, evidence, signal, voiceForRoute, contextFor) {
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
      const context = {
        ...(contextFor ? contextFor(deliverySignal) : {}),
        signal: deliverySignal,
        ...(voiceForRoute ? { voice: voiceForRoute(deliverySignal) } : {}),
      };
      result = await Promise.race([entry.onEvent(evidence, context), interrupted]);
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

/**
 * Persisted set of bots handed to an external consumer. A bot stays in this
 * mode across restarts, so its channel never answers through a DSH Session
 * while the consumer is still starting.
 */
export class ExternalModeStore {
  #path;
  #bots = new Set();
  #writing = Promise.resolve();

  constructor(path) {
    if (typeof path !== 'string' || !path) throw new TypeError('ExternalModeStore requires a path');
    this.#path = path;
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.#path, 'utf8'));
      if (value?.version === 1 && Array.isArray(value.bots)) {
        for (const botId of value.bots) if (identifier(botId)) this.#bots.add(botId);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return this;
  }

  has(botId) {
    return this.#bots.has(botId);
  }

  list() {
    return [...this.#bots];
  }

  async set(botId, external) {
    if (!identifier(botId)) throw new TypeError('A bot id is required');
    if (this.#bots.has(botId) === (external === true)) return;
    if (external === true) this.#bots.add(botId);
    else this.#bots.delete(botId);
    const snapshot = JSON.stringify({ version: 1, bots: [...this.#bots] });
    const write = this.#writing.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temp = `${this.#path}.${process.pid}.tmp`;
      try {
        await writeFile(temp, `${snapshot}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.#path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.#writing = write.catch(() => undefined);
    await write;
  }
}

/**
 * The runtime-side bridge used in place of a channel's DSH bridge while its bot
 * is in external-consumer mode. It normalizes inbound platform messages with
 * the channel's `normalize`, keeps a short per-conversation history of what it
 * saw and sent, serializes deliveries per conversation and replies through the
 * channel's `reply`.
 */
export class ExternalInboundBridge {
  #channel;
  #normalize;
  #reply;
  #deliver;
  #status;
  #logger;
  #signal;
  #seen = new Set();
  #chains = new Map();
  #tasks = new Set();
  #history = new Map();

  /**
   * @param {object} options
   * @param {string} options.channel
   * @param {(raw: any, options?: any) => (object | null | Promise<object | null>)} options.normalize
   *   Channel message → normalized message with attachment `load` functions, or null to ignore.
   * @param {(route: object, text: string, options: {signal?: AbortSignal, format?: string}) => Promise<object|void>} options.reply
   * @param {(message: object) => Promise<void>} options.deliver - Hands one normalized message to the host.
   * @param {object} [options.status] - The runtime's live status record.
   * @param {object} [options.logger]
   * @param {AbortSignal} [options.signal]
   */
  constructor({ channel, normalize, reply, deliver, status = {}, logger = console, signal }) {
    if (typeof normalize !== 'function' || typeof reply !== 'function' || typeof deliver !== 'function')
      throw new TypeError('An external bridge needs normalize, reply and deliver');
    this.#channel = channel;
    this.#normalize = normalize;
    this.#reply = reply;
    this.#deliver = deliver;
    this.#status = status;
    this.#logger = logger;
    this.#signal = signal;
  }

  get external() {
    return true;
  }

  get status() {
    return structuredClone(this.#status);
  }

  accept(raw, options) {
    if (this.#signal?.aborted) return Promise.resolve();
    const task = Promise.resolve()
      .then(() => this.#normalize(raw, options))
      .then((message) => {
        if (!message || this.#signal?.aborted) return undefined;
        const messageId = identifier(message.messageId);
        if (!messageId || this.#seen.has(messageId)) return undefined;
        this.#seen.add(messageId);
        if (this.#seen.size > MAX_SEEN) this.#seen.delete(this.#seen.values().next().value);
        this.#status.messagesReceived = (this.#status.messagesReceived ?? 0) + 1;
        this.#status.lastMessageAt = new Date().toISOString();
        this.#remember(message.conversation?.id, {
          messageId, direction: 'inbound', actor: message.actor, text: message.text ?? '',
          attachments: (message.attachments ?? []).map(({ kind, name }) => ({ kind, ...(name ? { name } : {}) })),
          at: new Date(message.at ?? Date.now()).toISOString(),
        });
        const key = message.conversation?.id ?? messageId;
        const previous = this.#chains.get(key) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(() => this.#deliver(message));
        this.#chains.set(key, current);
        void current.finally(() => {
          if (this.#chains.get(key) === current) this.#chains.delete(key);
        }).catch(() => undefined);
        return current;
      })
      .catch((error) => {
        if (this.#signal?.aborted) return;
        this.#status.lastError = `external consumer: ${error?.code ?? error?.name ?? 'error'}`;
        this.#logger.warn?.(`[dsh-im:${this.#channel}] inbound message was not handed to Muse (${error?.code ?? error?.name ?? 'error'})`);
      });
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
    return task;
  }

  /** Card and template callbacks belong to DSH Session flows; Muse answers cards by text. */
  acceptEvent() {
    return Promise.resolve();
  }

  acceptCard() {
    return Promise.resolve();
  }

  async presentSessionSyncApproval() {
    return false;
  }

  async reply(route, text, options = {}) {
    if (this.#signal?.aborted) throw refusal('bot-not-connected');
    const result = await this.#reply(route, text, options);
    this.#status.messagesReplied = (this.#status.messagesReplied ?? 0) + 1;
    this.#status.lastReplyAt = new Date().toISOString();
    this.#remember(route?.conversationId, {
      messageId: identifier(result?.messageId) ?? `sent:${Date.now()}`,
      direction: 'outbound', text, at: new Date().toISOString(),
    });
    return result;
  }

  /** Record a proactive send so history shows it next to the replies. */
  rememberSent(conversationId, text) {
    this.#remember(conversationId, { messageId: `sent:${Date.now()}`, direction: 'outbound', text, at: new Date().toISOString() });
  }

  /** Messages this bridge saw or sent in one conversation since it started, newest first. */
  history(conversationId, limit = 20) {
    const entries = this.#history.get(conversationId) ?? [];
    return entries.slice(-limit).reverse().map((entry) => structuredClone(entry));
  }

  #remember(conversationId, entry) {
    if (!identifier(conversationId)) return;
    let entries = this.#history.get(conversationId);
    if (!entries) {
      entries = [];
      this.#history.set(conversationId, entries);
      if (this.#history.size > MAX_CONVERSATIONS) this.#history.delete(this.#history.keys().next().value);
    }
    entries.push({ ...entry, text: String(entry.text ?? '').slice(0, 4_000) });
    if (entries.length > MAX_HISTORY_PER_CONVERSATION) entries.splice(0, entries.length - MAX_HISTORY_PER_CONVERSATION);
  }

  async waitForIdle() {
    await Promise.allSettled([...this.#tasks, ...this.#chains.values()]);
  }

  async close() {
    await this.waitForIdle();
  }
}
