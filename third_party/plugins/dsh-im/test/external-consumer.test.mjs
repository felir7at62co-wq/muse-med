import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createExternalConsumerHost, loadExternalConsumerHost } from '../plugin-src/host/external-consumer-host.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';
import {
  ExternalModeStore,
  externalAccountFingerprint,
  externalInboundEvent,
} from '../src/channels/shared/external-consumer.mjs';

const fingerprint = externalAccountFingerprint('dingtalk', 'dt_one');

async function tempPath(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dshim-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'external-consumers.json');
}

function message(overrides = {}) {
  return {
    messageId: 'm1',
    conversation: { kind: 'group', id: 'cid-1', title: 'Studio' },
    actor: { id: 'u1', name: 'Mei' },
    mentionedAccount: true,
    text: 'hello',
    attachments: [{ kind: 'image', name: 'image', load: async () => ({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }) }],
    reply: { kind: 'group', senderId: 'u1' },
    target: { kind: 'group', route: { openConversationId: 'cid-1' } },
    ...overrides,
  };
}

test('an external event carries metadata only, the account fingerprint and the reply route', () => {
  const event = externalInboundEvent({ channel: 'dingtalk', botId: 'dt_one', fingerprint, message: message() });
  assert.equal(event.version, 1);
  assert.equal(event.channel, 'dingtalk');
  assert.deepEqual(event.conversation, { kind: 'group', id: 'cid-1', title: 'Studio' });
  assert.deepEqual(event.attachments, [{ kind: 'image', name: 'image' }]);
  assert.deepEqual(event.reply, { kind: 'group', senderId: 'u1', messageId: 'm1', conversationId: 'cid-1' });
  assert.deepEqual(event.target, { kind: 'group', route: { openConversationId: 'cid-1' } });
  assert.equal(Object.isFrozen(event), true);
  assert.equal(externalInboundEvent({ channel: 'dingtalk', botId: 'dt_one', fingerprint, message: message({ text: ' ', attachments: [] }) }), null);
  assert.throws(() => externalInboundEvent({ channel: 'dingtalk', botId: 'dt_one', fingerprint, message: message({ reply: { nested: { no: 1 } } }) }), { code: 'invalid-inbound' });
  const long = externalInboundEvent({ channel: 'dingtalk', botId: 'dt_one', fingerprint, message: message({ text: 'x'.repeat(20_000) }) });
  assert.equal(long.text.length, 16_000);
});

test('the mode store keeps handed-over bots across restarts', async (t) => {
  const path = await tempPath(t);
  const store = await new ExternalModeStore(path).load();
  await store.set('dt_one', true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, bots: ['dt_one'] });
  const again = await new ExternalModeStore(path).load();
  assert.equal(again.has('dt_one'), true);
  await again.set('dt_one', false);
  assert.equal((await new ExternalModeStore(path).load()).has('dt_one'), false);
});

test('a consumer takes a bot: the runtime restarts external, waiting messages flow, replies and history go through its bridge', async (t) => {
  const path = await tempPath(t);
  const reconnects = [];
  let host;
  const runtimes = [];
  // A fake channel runtime: when the bot is external it builds the external bridge.
  const startRuntime = (botId) => {
    const hook = host.runtimeHook(botId);
    const controller = new AbortController();
    const replies = [];
    const bridge = hook?.createBridge({
      normalize: raw => raw,
      reply: async (route, text, options) => { replies.push({ route, text, format: options.format }); return { messageId: `sent-${replies.length}` }; },
      status: { ready: true },
      signal: controller.signal,
    });
    runtimes.forEach(runtime => runtime.controller.abort());
    const runtime = { controller, bridge, replies };
    runtimes.push(runtime);
    return runtime;
  };
  host = await loadExternalConsumerHost({
    channel: 'dingtalk', path,
    account: botId => (botId === 'dt_one' ? { name: 'Studio bot' } : null),
    reconnect: async (botId) => { reconnects.push(botId); startRuntime(botId); },
    consumerWaitMs: 2_000,
  });
  assert.equal(host.runtimeHook('dt_one'), undefined, 'a standalone bot gets no external bridge');
  const described = await host.describeDeliveryAccount('dt_one');
  assert.equal(described.mode, 'standalone');
  assert.equal(described.account.fingerprint, fingerprint);
  assert.ok(described.capabilities.includes('channel-neutral-consumer'));
  await assert.rejects(host.describeDeliveryAccount('dt_unknown'), { code: 'unknown-bot' });

  const events = [];
  const consumer = new AbortController();
  await assert.rejects(host.consumeInbound('dt_one', { expectedFingerprint: '0'.repeat(64), onEvent: () => ({ accepted: true }), signal: consumer.signal }), { code: 'account-changed' });
  const dispose = await host.consumeInbound('dt_one', {
    expectedFingerprint: fingerprint,
    signal: consumer.signal,
    async onEvent(event, context) {
      const image = await context.loadAttachment(0, { maxBytes: 100 });
      events.push({ event, image });
      return { accepted: true };
    },
  });
  assert.deepEqual(reconnects, ['dt_one']);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).bots, ['dt_one']);
  assert.equal((await host.describeDeliveryAccount('dt_one')).connected, true);
  const runtime = runtimes.at(-1);
  await runtime.bridge.accept(message());
  await runtime.bridge.accept(message());
  assert.equal(events.length, 1, 'a provider redelivery reaches the consumer once');
  assert.equal(events[0].event.text, 'hello');
  assert.equal(events[0].image.kind, 'image');
  assert.equal(events[0].image.data.length, 8);

  const reply = await host.replyChecked('dt_one', events[0].event.reply, 'answer', { expectedFingerprint: fingerprint, format: 'markdown' });
  assert.deepEqual(reply, { sent: true, messageId: 'sent-1' });
  assert.deepEqual(runtime.replies, [{ route: events[0].event.reply, text: 'answer', format: 'markdown' }]);
  const history = await host.historyChecked('dt_one', events[0].event.reply, { scope: 'group', limit: 5 }, { expectedFingerprint: fingerprint });
  assert.equal(history.coverage, 'seen-since-connect');
  assert.deepEqual(history.events.map(entry => [entry.direction, entry.text]), [['outbound', 'answer'], ['inbound', 'hello']]);

  dispose();
  await assert.rejects(host.replyChecked('dt_one', events[0].event.reply, 'late', { expectedFingerprint: fingerprint }), { code: 'consumer-unavailable' });
  // The bot stays external: a message waits for the next consumer instead of a DSH Session.
  const waiting = runtime.bridge.accept(message({ messageId: 'm2', text: 'while away' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  await host.consumeInbound('dt_one', { expectedFingerprint: fingerprint, onEvent: async (event) => { events.push({ event }); return { accepted: true }; } });
  await waiting;
  assert.equal(events.at(-1).event.text, 'while away');
  assert.deepEqual(reconnects, ['dt_one'], 'a runtime that is already external is not restarted');
  host.close();
});

test('a message that no consumer takes in time is dropped and reported', async (t) => {
  const path = await tempPath(t);
  const store = await new ExternalModeStore(path).load();
  await store.set('dt_one', true);
  const warnings = [];
  const host = createExternalConsumerHost({
    channel: 'dingtalk', modeStore: store, account: () => ({}), reconnect: async () => {}, consumerWaitMs: 10,
    logger: { warn: message => warnings.push(message) },
  });
  const status = { ready: true };
  const bridge = host.runtimeHook('dt_one').createBridge({ normalize: raw => raw, reply: async () => {}, status, logger: { warn: message => warnings.push(message) } });
  await bridge.accept(message());
  assert.match(status.lastError, /consumer-unavailable/);
  assert.equal(warnings.length, 1);
});

test('the delivery service sends a proactive text to an event target only for the pinned account', async (t) => {
  const path = await tempPath(t);
  const host = await loadExternalConsumerHost({ channel: 'dingtalk', path, account: () => ({ name: 'bot' }), reconnect: async () => {} });
  const sent = [];
  const service = createDeliveryService();
  service.registerAdapter(createDeliveryAdapter({
    channel: 'dingtalk',
    workspaces: { has: botId => botId === 'dt_one', listBotIds: () => ['dt_one'], listDeliveryTargets: () => [] },
    coreController: { sendProactiveText: async (botId, target, text, options) => { sent.push({ botId, target, text, format: options.format }); return { sent: true }; } },
    stateFor: async () => null,
    external: host,
  }));
  const target = { kind: 'group', route: { openConversationId: 'cid-1' } };
  assert.deepEqual(await service.pushChecked('dt_one', target, 'report', { expectedFingerprint: fingerprint, format: 'markdown' }), { sent: true });
  assert.deepEqual(sent, [{ botId: 'dt_one', target: { targetId: '__test__', kind: 'group', route: { openConversationId: 'cid-1' } }, text: 'report', format: 'markdown' }]);
  await assert.rejects(service.pushChecked('dt_one', target, 'report', { expectedFingerprint: '0'.repeat(64) }), { code: 'account-changed' });
  await assert.rejects(service.pushChecked('dt_one', { kind: 'group', route: { chatId: 'x' } }, 'report', { expectedFingerprint: fingerprint }), { code: 'invalid-target' });
  assert.equal((await service.describeBot('dt_one')).channel, 'dingtalk');
  assert.equal(sent.length, 1);
});
