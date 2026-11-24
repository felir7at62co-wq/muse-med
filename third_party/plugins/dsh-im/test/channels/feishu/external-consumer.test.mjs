import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExternalCard, normalizeExternalText, ExclusiveInboundConsumers } from '../../../src/channels/feishu/external-consumer.mjs';

test('rich consumers receive authenticated image routes and button callbacks', () => {
  const identity = { botId: 'bot', appId: 'app', botOpenId: 'ou_bot', fingerprint: '0'.repeat(64) };
  const image = { app_id: 'app', event_id: 'evt', sender: { sender_type: 'user', sender_id: { open_id: 'ou_member' } },
    message: { chat_type: 'group', message_type: 'image', chat_id: 'oc_group', message_id: 'om_image',
      create_time: '1700000000000', content: '{"image_key":"img_example"}' } };
  assert.equal(normalizeExternalText(image, identity), null);
  const normalized = normalizeExternalText(image, { ...identity, rich: true, groupResponseMode: 'all' });
  assert.equal(normalized.imageKey, 'img_example');
  assert.equal(normalized.groupResponseMode, 'all');
  assert.equal(normalized.reply.actorId, 'ou_member');
  const callback = { app_id: 'app', operator: { open_id: 'ou_member' }, context: { open_chat_id: 'oc_group',
    open_message_id: 'om_card' }, action: { value: { v: 'q:example:1' } } };
  assert.equal(normalizeExternalCard(callback, identity).value, 'q:example:1');
  assert.throws(() => normalizeExternalCard({ ...callback, app_id: 'other' }, identity), { code: 'account-changed' });
});

const fingerprint = 'a'.repeat(64);
function event() {
  return {
    event_id: 'event-1', app_id: 'app',
    sender: { sender_type: 'user', sender_id: { open_id: 'actor' } },
    message: { message_id: 'message', chat_id: 'conversation', chat_type: 'group',
      message_type: 'text', content: JSON.stringify({ text: '@_user_1 hello' }),
      mentions: [{ id: { open_id: 'bot-open-id' }, key: '@_user_1', name: 'Platform Bot' }],
      create_time: '1790787600000', thread_id: 'thread', root_id: 'root', parent_id: 'parent' },
  };
}
function normalized(value = event()) {
  return normalizeExternalText(value, { botId: 'bot', appId: 'app', botOpenId: 'bot-open-id', fingerprint });
}

test('normalized authenticated text retains causal identities without raw payload or secrets', () => {
  const input = event();
  input.secret = 'private-material';
  const evidence = normalized(input);
  assert.deepEqual(evidence.reply, { messageId: 'message', conversationId: 'conversation', actorId: 'actor',
    threadId: 'thread', rootId: 'root', parentId: 'parent' });
  assert.equal(evidence.replay.gapPossible, true);
  assert.equal(Object.isFrozen(evidence.reply), true);
  assert.equal(JSON.stringify(evidence).includes('private-material'), false);
  input.message.chat_id = 'other';
  assert.equal(evidence.conversation.id, 'conversation');
  assert.throws(() => normalized({ ...input, app_id: 'other' }), { code: 'account-changed' });
  assert.equal(normalized({ ...input, sender: { sender_type: 'bot' } }), null);
  assert.equal(evidence.conversation.kind, 'group');
  assert.equal(evidence.mentionedAccount, true);
  assert.deepEqual(evidence.mentions, [{ id: 'bot-open-id', key: '@_user_1', name: 'Platform Bot' }]);
  assert.equal(Object.isFrozen(evidence.mentions[0]), true);
  assert.equal(normalized({ ...input, message: { ...input.message, chat_type: 'unknown' } }), null);
});

test('exclusive registration waits for durable acceptance and disposal never substitutes another consumer', async () => {
  const consumers = new ExclusiveInboundConsumers();
  let commit;
  const committed = new Promise(resolve => { commit = resolve; });
  let calls = 0;
  const dispose = consumers.register('bot', { fingerprint, onEvent: async () => {
    calls++; await committed; return { accepted: true };
  } });
  assert.throws(() => consumers.register('bot', { fingerprint, onEvent() {} }), { code: 'consumer-conflict' });
  let acknowledged = false;
  const pending = consumers.accept('bot', normalized()).then(() => { acknowledged = true; });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  commit(); await pending;
  assert.equal(calls, 1);
  dispose(); dispose();
  await assert.rejects(consumers.accept('bot', normalized()), { code: 'consumer-unavailable' });
});

test('consumer loss during commit rejects acknowledgement even when a new registration appears', async () => {
  const consumers = new ExclusiveInboundConsumers();
  let commit;
  const committed = new Promise(resolve => { commit = resolve; });
  const dispose = consumers.register('bot', { fingerprint, onEvent: async () => {
    await committed; return { accepted: true };
  } });
  const pending = consumers.accept('bot', normalized());
  dispose();
  consumers.register('bot', { fingerprint, onEvent: async () => ({ accepted: true }) });
  commit();
  await assert.rejects(pending, { code: 'consumer-unavailable' });
  consumers.close();
});

test('fingerprint mismatch, uncommitted result and canceled registrations fail closed', async () => {
  const consumers = new ExclusiveInboundConsumers();
  const controller = new AbortController();
  let calls = 0;
  consumers.register('bot', { fingerprint, signal: controller.signal, onEvent: async () => {
    calls++; return { accepted: false };
  } });
  await assert.rejects(consumers.accept('bot', { ...normalized(), fingerprint: 'b'.repeat(64) }), { code: 'account-changed' });
  assert.equal(calls, 0);
  await assert.rejects(consumers.accept('bot', normalized()), { code: 'ingress-not-accepted' });
  controller.abort();
  await assert.rejects(consumers.accept('bot', normalized()), { code: 'consumer-unavailable' });
});


test('ordinary group text and another Bot mention retain context without implying attention for this account', () => {
  const input = event();
  input.message.mentions = [{ id: { open_id: 'other-bot' }, key: '@_user_2' }];
  const otherMention = normalized(input);
  assert.equal(otherMention.mentionedAccount, false);
  assert.deepEqual(otherMention.mentions, [{ id: 'other-bot', key: '@_user_2' }]);
  input.message.mentions = [];
  input.message.content = JSON.stringify({ text: 'ordinary team context' });
  assert.equal(normalized(input).mentionedAccount, false);
  assert.equal(normalized(input).text, 'ordinary team context');
  input.message.chat_type = 'p2p';
  assert.equal(normalized(input).conversation.kind, 'dm');
});

test('group evidence requires authenticated account identity and valid mention and timestamp fields', () => {
  assert.throws(() => normalizeExternalText(event(), { botId: 'bot', appId: 'app', fingerprint }), { code: 'account-unverified' });
  const input = event();
  input.message.mentions = [{ id: { open_id: 'bot-open-id' }, key: '' }];
  assert.throws(() => normalized(input), { code: 'invalid-inbound' });
  input.message.mentions = [];
  input.message.create_time = '9e99';
  assert.throws(() => normalized(input), { code: 'invalid-inbound' });
});

test('voice controls are attached only for an authenticated audio event and share the consumer cancellation', async () => {
  const input = event();
  input.message.message_type = 'audio';
  input.message.content = '{"file_key":"file_1"}';
  const identity = { botId: 'bot', appId: 'app', botOpenId: 'bot-open-id', fingerprint };
  assert.equal(normalizeExternalText(input, identity), null);
  const routed = normalizeExternalText(input, { ...identity, rich: true, stepPushMode: 'streaming_card' });
  assert.equal(routed.audioKey, 'file_1');
  assert.equal(routed.text, '');
  assert.equal(routed.stepPushMode, 'streaming_card');
  const consumers = new ExclusiveInboundConsumers();
  const voice = { transcribe: async () => 'voice-to-text' };
  let signal;
  const release = consumers.register('bot', { fingerprint, async onEvent(evidence, ctx) {
    assert.equal(evidence.reply.chatId, undefined);
    assert.equal(evidence.reply.conversationId, 'conversation');
    assert.equal(ctx.voice, voice);
    signal = ctx.signal;
    return { accepted: true };
  } });
  await consumers.accept('bot', routed, undefined, () => voice);
  release();
  assert.equal(signal.aborted, true);
});

test('rich consumers receive posts, files, videos and the type of what nothing can read; text consumers still receive text only', () => {
  const identity = { botId: 'bot', appId: 'app', botOpenId: 'ou_bot', fingerprint: '0'.repeat(64) };
  const rich = { ...identity, rich: true };
  const inbound = (type, content) => ({ app_id: 'app', event_id: `evt_${type}`, sender: { sender_type: 'user', sender_id: { open_id: 'ou_member' } },
    message: { chat_type: 'p2p', message_type: type, chat_id: 'oc_dm', message_id: `om_${type}`, create_time: '1700000000000', content } });
  const postBody = { title: 'Episode 3', content: [[{ tag: 'text', text: 'see ' }, { tag: 'a', href: 'https://example.com', text: 'outline' }], [{ tag: 'img', image_key: 'img_1' }]] };
  for (const content of [postBody, { zh_cn: postBody }]) {
    const post = normalizeExternalText(inbound('post', JSON.stringify(content)), rich);
    assert.equal(post.messageType, 'post');
    assert.deepEqual(post.post, postBody);
    assert.equal(post.text, '');
    assert.equal(normalizeExternalText(inbound('post', JSON.stringify(content)), identity), null);
  }
  const file = normalizeExternalText(inbound('file', JSON.stringify({ file_key: 'file_1', file_name: ' plan.txt ' })), rich);
  assert.deepEqual([file.messageType, file.fileKey, file.fileName], ['file', 'file_1', 'plan.txt']);
  const media = normalizeExternalText(inbound('media', JSON.stringify({ file_key: 'file_2', image_key: 'img_cover' })), rich);
  assert.deepEqual([media.messageType, media.fileKey, media.fileName, media.imageKey], ['media', 'file_2', undefined, undefined]);
  const forwarded = normalizeExternalText(inbound('merge_forward', 'Merged and Forwarded Message'), rich);
  assert.deepEqual([forwarded.messageType, forwarded.text, forwarded.fileKey], ['merge_forward', '', undefined]);
  const sticker = normalizeExternalText(inbound('sticker', JSON.stringify({ file_key: 'file_3' })), rich);
  assert.deepEqual([sticker.messageType, sticker.fileKey], ['sticker', undefined]);
  assert.equal(normalizeExternalText(inbound('text', JSON.stringify({ text: 'hi' })), identity).messageType, undefined);
  assert.throws(() => normalizeExternalText(inbound('text', JSON.stringify({ text: ' ' })), identity), { code: 'invalid-inbound' });
  assert.throws(() => normalizeExternalText(inbound('text', 'not json'), rich), { code: 'invalid-inbound' });
});
