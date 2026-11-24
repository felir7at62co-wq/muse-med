import assert from 'node:assert/strict';
import test from 'node:test';

import { wecomAppExternalChannel } from '../../../src/channels/wecom-app/wecom-app-external.mjs';

test('a WeCom app message is a private chat answered through the message API', async () => {
  const sent = [];
  const channel = wecomAppExternalChannel({ api: {}, sendText: async (target, text) => { sent.push({ target, text }); } });
  const normalized = channel.normalize({ msgid: 'm1', msgtype: 'text', text: { content: '进度如何' }, from: { userid: 'li' }, createTime: 1_700_000_000 });
  assert.deepEqual(normalized.conversation, { kind: 'dm', id: 'li' });
  assert.equal(normalized.text, '进度如何');
  assert.equal(normalized.at, 1_700_000_000_000);
  assert.deepEqual(normalized.target, { kind: 'user', route: { chatId: 'li' } });
  await channel.reply({ messageId: 'm1', conversationId: 'li' }, '正在写第 3 集');
  assert.deepEqual(sent, [{ target: { kind: 'user', route: { chatId: 'li' } }, text: '正在写第 3 集' }]);
  assert.equal(channel.normalize({ msgid: 'm2', msgtype: 'location', from: { userid: 'li' } }), null);
  const image = channel.normalize({ msgid: 'm3', msgtype: 'image', mediaId: 'media-1', from: { userid: 'li' } });
  assert.deepEqual(image.attachments.map(item => item.kind), ['image']);
});
