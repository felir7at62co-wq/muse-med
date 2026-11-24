import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { textExternalChannel } from '../../../src/channels/shared/text-external.mjs';
import { IMessageRuntime } from '../../../src/channels/imessage/runtime.mjs';
import { loadExternalConsumerHost } from '../../../plugin-src/host/external-consumer-host.mjs';
import { externalAccountFingerprint } from '../../../src/channels/shared/external-consumer.mjs';
import { normalizeDeliveryTarget } from '../../../plugin-src/host/delivery-adapter.mjs';

const fakeBot = () => {
  const sent = [];
  return {
    sent,
    sendText: async (target, text) => { sent.push({ target, text }); },
    sendDelivery: async (target, block) => { sent.push({ target, block }); },
  };
};

// One text-bridge message per channel, shaped like that channel's runtime produces it.
const SAMPLES = {
  telegram: { kind: 'group', conversationId: '-1001:7', addressed: true, replyTarget: { chatId: -1001, chatType: 'supergroup', messageThreadId: 7 },
    target: { kind: 'topic', route: { chatId: '-1001', messageThreadId: 7 } } },
  discord: { kind: 'group', conversationId: '9001', addressed: true, replyTarget: { channelId: '9001', replyToMessageId: 'x' },
    target: { kind: 'channel', route: { channelId: '9001' } } },
  slack: { kind: 'group', conversationId: 'C1:171.1', addressed: true, replyTarget: { channelId: 'C1', threadTs: '171.1', recipientUserId: 'U1' },
    target: { kind: 'thread', route: { channelId: 'C1', threadTs: '171.1' } } },
  whatsapp: { kind: 'group', conversationId: '120363000000000000@g.us', addressed: true, replyTarget: { jid: '120363000000000000@g.us', quoted: {} },
    target: { kind: 'group', route: { jid: '120363000000000000@g.us' } } },
  matrix: { kind: 'group', conversationId: '!room:example.org', addressed: true, replyTarget: { roomId: '!room:example.org', recipientUserId: '@u:example.org' },
    target: { kind: 'room', route: { roomId: '!room:example.org' } } },
  imessage: { kind: 'direct', conversationId: 'iMessage;-;+8613800000000', addressed: true, replyTarget: { chatGuid: 'iMessage;-;+8613800000000', address: '+8613800000000' },
    target: { kind: 'user', route: { chatGuid: 'iMessage;-;+8613800000000' } } },
  email: { kind: 'direct', conversationId: 'thread-1', addressed: true, replyTarget: { to: 'Mei <Mei@Example.com>', subject: 'Re: 剧本', messageId: '<m1@example.com>' },
    target: { kind: 'user', route: { address: 'mei@example.com' } } },
};

for (const [channel, sample] of Object.entries(SAMPLES)) {
  test(`${channel} text-bridge messages become channel-neutral messages with a valid proactive target`, async () => {
    const bot = fakeBot();
    const external = textExternalChannel({ channel, bot });
    const { target, ...fields } = sample;
    const normalized = external.normalize({
      messageId: `${channel}-1`, senderId: 'u1', senderName: 'Mei', content: ' 看下第二集 ', images: [], files: [{ name: 'brief.pdf', load: async () => Buffer.from('pdf') }],
      contextSource: () => ({ senderName: 'Mei', conversationTitle: fields.kind === 'group' ? '剧组' : undefined }), ...fields,
    });
    assert.equal(normalized.text, '看下第二集');
    assert.deepEqual(normalized.conversation, { kind: fields.kind === 'group' ? 'group' : 'dm', id: fields.conversationId, title: fields.kind === 'group' ? '剧组' : 'Mei' });
    assert.deepEqual(normalized.target, target);
    assert.deepEqual(normalizeDeliveryTarget(channel, target, { targetIdRequired: false }), target, 'the target passes the delivery rules');
    assert.deepEqual(normalized.attachments.map(item => [item.kind, item.name]), [['file', 'brief.pdf']]);
    await external.reply({ messageId: `${channel}-1`, conversationId: fields.conversationId }, '**ok**', { format: 'markdown' });
    assert.deepEqual(bot.sent[0].target, fields.replyTarget);
    assert.equal(bot.sent[0].block.format, 'markdown');
    await external.reply({ messageId: `${channel}-1`, conversationId: fields.conversationId }, 'plain', {});
    assert.deepEqual(bot.sent[1], { target: fields.replyTarget, text: 'plain' });
    await assert.rejects(external.reply({ messageId: 'unknown', conversationId: 'x' }, 'x'), { code: 'stale-route' });
    assert.equal(external.normalize({ ...fields, messageId: 'b', senderId: 'bot', senderIsBot: true, content: 'x' }), null);
  });
}

test('an iMessage runtime handed to Muse polls without a DSH Session and answers through the gateway', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dshim-imessage-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sent = [];
  let rows = [{ rowid: 1, guid: 'g1', chatGuid: 'iMessage;-;+86100', text: '在吗', sender: '+86100' }];
  const api = {
    getPermissions: async () => ({ database: 'granted', automation: 'granted' }),
    listMessages: async () => { const out = rows; rows = []; return out; },
    sendText: async (request) => { sent.push(request); },
  };
  let cursor = null;
  let runtime;
  const host = await loadExternalConsumerHost({
    channel: 'imessage', path: join(dir, 'external.json'), account: () => ({ name: 'Mac' }),
    reconnect: async () => {
      await runtime?.stop();
      runtime = new IMessageRuntime({
        config: { botId: 'im_one', platformId: 'me' }, token: 'unused',
        harness: { ensureRunning: async () => { throw new Error('a DSH Session must not be needed'); } },
        state: { cursor: () => cursor, setCursor: async (value) => { cursor = value; } },
        pollIntervalMs: 5, createApi: () => api, external: host.runtimeHook('im_one'), logger: { warn() {}, error() {} },
      });
      await runtime.start();
    },
  });
  t.after(() => runtime?.stop());
  const fingerprint = externalAccountFingerprint('imessage', 'im_one');
  const events = [];
  await host.consumeInbound('im_one', { expectedFingerprint: fingerprint, onEvent: async (event) => { events.push(event); return { accepted: true }; } });
  const deadline = Date.now() + 1_000;
  while (events.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(events.length, 1);
  assert.equal(events[0].text, '在吗');
  assert.deepEqual(events[0].target, { kind: 'user', route: { chatGuid: 'iMessage;-;+86100' } });
  await host.replyChecked('im_one', events[0].reply, '在的', { expectedFingerprint: fingerprint });
  assert.deepEqual(sent.map(request => [request.chatGuid, request.text]), [['iMessage;-;+86100', '在的']]);
  host.close();
});
