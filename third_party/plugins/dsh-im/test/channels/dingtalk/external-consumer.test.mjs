import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DingtalkRuntime } from '../../../src/channels/dingtalk/dingtalk-runtime.mjs';
import { dingtalkExternalChannel, markdownTitle } from '../../../src/channels/dingtalk/dingtalk-external.mjs';
import { loadExternalConsumerHost } from '../../../plugin-src/host/external-consumer-host.mjs';
import { externalAccountFingerprint } from '../../../src/channels/shared/external-consumer.mjs';

const WEBHOOK = 'https://oapi.dingtalk.com/robot/sendBySession?session=inbound';

function groupMessage(overrides = {}) {
  return {
    msgId: 'msg-1', msgtype: 'text', text: { content: ' 做一个预告 ' },
    conversationType: '2', conversationId: 'cid-group', conversationTitle: '剧组群',
    senderStaffId: 'staff-1', senderNick: '小梅', isInAtList: true, robotCode: 'ding-client',
    sessionWebhook: WEBHOOK, sessionWebhookExpiredTime: 1_700_003_600_000, createAt: 1_700_000_000_000,
    ...overrides,
  };
}

test('a DingTalk group message becomes a channel-neutral message and is answered on its session webhook', async () => {
  const sends = [];
  const robot = [];
  let now = 1_700_000_000_000;
  const channel = dingtalkExternalChannel({
    api: {
      sendText: async (request) => { sends.push(request); return true; },
      sendRobotText: async (request) => { robot.push(request); },
      downloadImage: async () => ({ data: Buffer.from('img') }),
      downloadFile: async () => Buffer.from('file'),
    },
    clientId: 'ding-client', clientSecret: 'secret', now: () => now,
  });
  const normalized = channel.normalize(groupMessage());
  assert.equal(normalized.messageId, 'msg-1');
  assert.deepEqual(normalized.conversation, { kind: 'group', id: 'cid-group', title: '剧组群' });
  assert.deepEqual(normalized.actor, { id: 'staff-1', name: '小梅' });
  assert.equal(normalized.mentionedAccount, true);
  assert.equal(normalized.text, '做一个预告');
  assert.deepEqual(normalized.target, { kind: 'group', route: { openConversationId: 'cid-group' } });
  assert.equal(JSON.stringify(normalized.reply).includes('session='), false, 'the webhook token stays in dsh-im');

  await channel.reply({ ...normalized.reply, messageId: 'msg-1', conversationId: 'cid-group' }, '## 好的\n已开始', { format: 'markdown' });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].sessionWebhook, WEBHOOK);
  assert.equal(sends[0].markdownTitle, '好的');
  assert.deepEqual(sends[0].at, { atUserIds: ['staff-1'] });

  now = 1_700_003_600_000; // The webhook expired: a late answer goes through the robot API.
  await channel.reply({ ...normalized.reply, messageId: 'msg-1', conversationId: 'cid-group' }, 'late', { format: 'markdown' });
  assert.equal(sends.length, 1);
  assert.deepEqual(robot.map(request => [request.target, request.format]), [[{ type: 'group', robotCode: 'ding-client', openConversationId: 'cid-group' }, 'markdown']]);
});

test('a DingTalk private voice message keeps DingTalk\'s transcript and the recording', async () => {
  const channel = dingtalkExternalChannel({
    api: { downloadFile: async ({ downloadCode }) => Buffer.from(downloadCode) },
    clientId: 'ding-client', clientSecret: 'secret',
  });
  const normalized = channel.normalize({
    msgId: 'msg-voice', msgtype: 'audio', conversationType: '1', senderStaffId: 'staff-2', senderNick: 'Lu',
    content: { recognition: '明天开机', downloadCode: 'code-1' }, robotCode: 'ding-client',
  });
  assert.deepEqual(normalized.conversation, { kind: 'dm', id: 'staff-2', title: 'Lu' });
  assert.equal(normalized.text, '明天开机');
  assert.deepEqual(normalized.attachments.map(item => item.kind), ['audio']);
  assert.equal((await normalized.attachments[0].load({})).toString(), 'code-1');
  assert.deepEqual(normalized.target, { kind: 'user', route: { userId: 'staff-2' } });
  assert.equal(channel.normalize({ msgId: 'x', conversationType: '3', senderStaffId: 's' }), null);
  assert.equal(markdownTitle('# \n\n**粗体** 标题'), '粗体 标题');
});

test('a DingTalk runtime handed to Muse needs no DSH Session and hands its messages to the consumer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dshim-dt-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const listeners = new Map();
  const client = {
    connected: true, socket: { readyState: 1 },
    registerCallbackListener(topic, callback) { listeners.set(topic, callback); },
    socketCallBackResponse() {},
    async connect() {}, async disconnect() {},
  };
  const sends = [];
  let runtime;
  const host = await loadExternalConsumerHost({
    channel: 'dingtalk', path: join(dir, 'external.json'), account: () => ({ name: 'bot' }),
    reconnect: async () => {
      await runtime?.stop();
      runtime = new DingtalkRuntime({
        config: { botId: 'dt_one', clientId: 'ding-client', approvedSenders: [] },
        clientSecret: 'secret',
        harness: { ensureRunning: async () => { throw new Error('a DSH Session must not be needed'); } },
        state: { hasSeen: () => false, pendingSenders: () => [] },
        api: { sendText: async request => { sends.push(request); return true; } },
        streamFactory: async () => ({ client, topic: 'robot-topic' }),
        external: host.runtimeHook('dt_one'),
        logger: { warn() {}, error() {} },
      });
      await runtime.start();
    },
  });
  t.after(() => runtime?.stop());
  const fingerprint = externalAccountFingerprint('dingtalk', 'dt_one');
  const events = [];
  await host.consumeInbound('dt_one', { expectedFingerprint: fingerprint, onEvent: async (event) => { events.push(event); return { accepted: true }; } });
  assert.equal(runtime.status.ready, true);
  listeners.get('robot-topic')({ headers: { messageId: 'cb-1' }, data: JSON.stringify(groupMessage({ sessionWebhookExpiredTime: Date.now() + 3_600_000 })) });
  const deadline = Date.now() + 1_000;
  while (events.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, 'dingtalk');
  assert.equal(events[0].text, '做一个预告');
  await host.replyChecked('dt_one', events[0].reply, '收到', { expectedFingerprint: fingerprint, format: 'plain' });
  assert.deepEqual(sends.map(request => [request.sessionWebhook, request.text, request.markdownTitle]), [[WEBHOOK, '收到', undefined]]);
  host.close();
});
