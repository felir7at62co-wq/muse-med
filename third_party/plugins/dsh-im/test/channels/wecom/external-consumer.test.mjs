import assert from 'node:assert/strict';
import test from 'node:test';

import { wecomExternalChannel } from '../../../src/channels/wecom/wecom-external.mjs';

function frame(body) {
  return { headers: { req_id: 'req-1' }, body: { msgid: 'msg-1', chattype: 'group', chatid: 'chat-9', from: { userid: 'zhang' }, msgtype: 'text', text: { content: '@Muse 写个开场' }, ...body } };
}

test('a WeCom group message drops the routing mention and answers its frame first, then the chat', async () => {
  const calls = [];
  let now = 0;
  const client = {
    replyStream: async (sent, streamId, content, finish) => { calls.push(['stream', sent.body.msgid, content, finish]); },
    sendMessage: async (chatId, body) => { calls.push(['send', chatId, body.markdown.content]); },
  };
  const channel = wecomExternalChannel({ client, now: () => now, newReqId: () => 'stream-1' });
  const normalized = channel.normalize(frame());
  assert.equal(normalized.text, '写个开场');
  assert.deepEqual(normalized.conversation, { kind: 'group', id: 'chat-9' });
  assert.deepEqual(normalized.target, { kind: 'group', route: { chatId: 'chat-9' } });
  const route = { ...normalized.reply, messageId: 'msg-1', conversationId: 'chat-9' };
  await channel.reply(route, 'first answer');
  await channel.reply(route, 'second answer');
  assert.deepEqual(calls, [['stream', 'msg-1', 'first answer', true], ['send', 'chat-9', 'second answer']]);
  now = 10 * 60_000;
  channel.normalize(frame({ msgid: 'msg-2' }));
  now += 6 * 60_000; // The passive window closed: the answer is sent into the chat.
  await channel.reply({ ...route, messageId: 'msg-2' }, 'late');
  assert.deepEqual(calls.at(-1), ['send', 'chat-9', 'late']);
});

test('a WeCom private message is a direct chat with the sender; images and files load lazily', async () => {
  const client = { downloadFile: async () => ({ buffer: Buffer.from('bytes'), filename: 'a.png' }) };
  const channel = wecomExternalChannel({ client });
  const normalized = channel.normalize(frame({ chattype: 'single', chatid: undefined, msgtype: 'image', image: { url: 'https://example.invalid/a', aeskey: 'k' } }));
  assert.deepEqual(normalized.conversation, { kind: 'dm', id: 'zhang' });
  assert.deepEqual(normalized.attachments.map(item => item.kind), ['image']);
  assert.equal((await normalized.attachments[0].load({ maxBytes: 100 })).data.toString(), 'bytes');
  assert.equal(channel.normalize({ body: { msgid: 'x', chattype: 'other', from: { userid: 'u' } } }), null);
});
