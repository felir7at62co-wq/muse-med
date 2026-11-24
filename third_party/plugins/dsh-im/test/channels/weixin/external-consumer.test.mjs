import assert from 'node:assert/strict';
import test from 'node:test';

import { weixinExternalChannel } from '../../../src/channels/weixin/weixin-external.mjs';

test('a WeChat message remembers its context token, skips the bot\'s own echo and replies as plain text', async () => {
  const tokens = [];
  const sent = [];
  const channel = weixinExternalChannel({
    api: {},
    state: { rememberContextToken: async (entry) => { tokens.push(entry); }, recentOutboundTextFor: () => undefined },
    sendText: async (target, text, options) => { sent.push({ target, text, format: options.format }); },
  });
  assert.equal(await channel.normalize({ message_type: 2, message_id: 1, from_user_id: 'wx-bot' }), null);
  const normalized = await channel.normalize({
    message_id: 42, from_user_id: 'wx-user', context_token: 'ctx-1', create_time_ms: 1_700_000_000_000,
    item_list: [{ type: 3, voice_item: { text: '把第二场改短' } }],
  });
  assert.equal(normalized.messageId, '42');
  assert.equal(normalized.text, '把第二场改短');
  assert.deepEqual(normalized.conversation, { kind: 'dm', id: 'wx-user' });
  assert.deepEqual(normalized.target, { kind: 'user', route: { toUserId: 'wx-user' } });
  assert.deepEqual(tokens.map(entry => [entry.userId, entry.contextToken]), [['wx-user', 'ctx-1']]);
  await channel.reply({ messageId: '42', conversationId: 'wx-user' }, '好的', { format: 'markdown' });
  assert.deepEqual(sent, [{ target: { kind: 'user', route: { toUserId: 'wx-user' } }, text: '好的', format: 'plain' }]);
});
