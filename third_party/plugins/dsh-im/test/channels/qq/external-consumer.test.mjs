import assert from 'node:assert/strict';
import test from 'node:test';

import { qqExternalChannel } from '../../../src/channels/qq/qq-external.mjs';

function groupMessage(overrides = {}) {
  return {
    kind: 'group', messageId: 'qq-1', senderId: 'member-1', senderName: '阿青', groupOpenid: 'group-7', content: '出个海报',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE', replyTarget: { scope: 'group', targetId: 'group-7', msgId: 'qq-1' },
    timestamp: '2026-11-23T10:00:00+08:00', ...overrides,
  };
}

test('a QQ group message is answered passively within QQ\'s window and quota, then actively', async () => {
  const sent = [];
  let now = 0;
  const bot = { send: async (request) => { sent.push(request); return { id: `r${sent.length}` }; } };
  const channel = qqExternalChannel({ bot, now: () => now, logger: { warn() {} } });
  const normalized = channel.normalize(groupMessage());
  assert.deepEqual(normalized.conversation, { kind: 'group', id: 'group-7' });
  assert.equal(normalized.mentionedAccount, true);
  assert.deepEqual(normalized.actor, { id: 'member-1', name: '阿青' });
  assert.deepEqual(normalized.target, { kind: 'group', route: { groupOpenId: 'group-7' } });
  const route = { ...normalized.reply, messageId: 'qq-1', conversationId: 'group-7' };
  for (let index = 0; index < 6; index += 1) await channel.reply(route, `第 ${index + 1} 段`);
  assert.deepEqual(sent.slice(0, 5).map(request => request.target.msgId), ['qq-1', 'qq-1', 'qq-1', 'qq-1', 'qq-1']);
  assert.deepEqual(sent[5].target, { scope: 'group', targetId: 'group-7' }, 'the sixth reply exceeds the passive quota');
  channel.normalize(groupMessage({ messageId: 'qq-2', replyTarget: { scope: 'group', targetId: 'group-7', msgId: 'qq-2' } }));
  now = 6 * 60_000;
  await channel.reply({ ...route, messageId: 'qq-2' }, 'late');
  assert.deepEqual(sent.at(-1).target, { scope: 'group', targetId: 'group-7' });
  assert.equal(sent.at(-1).msgType, 2, 'answers go out as Markdown');
});

test('a QQ private voice message uses QQ\'s transcript; bot messages are ignored', () => {
  const channel = qqExternalChannel({ bot: {} });
  const normalized = channel.normalize({ kind: 'c2c', messageId: 'qq-3', senderId: 'user-1', content: '',
    attachments: [{ content_type: 'audio/silk', url: 'https://example.invalid/v', asr_refer_text: '改成悬疑风' }],
    replyTarget: { scope: 'c2c', targetId: 'user-1', msgId: 'qq-3' } });
  assert.equal(normalized.text, '改成悬疑风');
  assert.deepEqual(normalized.conversation, { kind: 'dm', id: 'user-1' });
  assert.deepEqual(normalized.attachments.map(item => item.kind), ['audio']);
  assert.deepEqual(normalized.target, { kind: 'user', route: { userOpenId: 'user-1' } });
  assert.equal(channel.normalize({ kind: 'c2c', messageId: 'x', senderId: 'bot', senderIsBot: true }), null);
});
