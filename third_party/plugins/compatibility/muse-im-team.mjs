/** Bind each native Feishu chat to one named Muse Bot without replaying its Session. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInboundClaims } from './muse-feishu-reliability.mjs'

const transactions = new Map()
const groupChat = key => typeof key === 'string' ? /^group:(oc_[A-Za-z0-9_-]+)$/u.exec(key)?.[1] : undefined
const chatIdentifier = value => typeof value === 'string' && /^oc_[A-Za-z0-9_-]+$/u.test(value)
const directKey = value => typeof value === 'string' && /^p2p:ou_[A-Za-z0-9_-]+$/u.test(value)
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
const title = value => typeof value === 'string' && value.trim() && value.length <= 1024 ? value.trim() : undefined
const failure = (code, message) => Object.assign(new Error(message), { code })

async function serial(path, operation) {
  const before = transactions.get(path) ?? Promise.resolve()
  const running = before.catch(() => {}).then(operation)
  transactions.set(path, running)
  try { return await running }
  finally { if (transactions.get(path) === running) transactions.delete(path) }
}

function privateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  let descriptor
  let published = false
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    published = true
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (!published) {
      try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
}

function bindingStore(path, identity, limits) {
  const empty = () => ({ version: 1, identity, bindings: {}, replies: {}, chats: {} })
  function read() {
    try {
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Muse IM team bindings must be a regular file')
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (value?.version !== 1 || value.identity?.imBotId !== identity.imBotId || value.identity?.appId !== identity.appId
        || !value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)
        || !value.replies || typeof value.replies !== 'object' || Array.isArray(value.replies)
        || Object.keys(value.bindings).length > limits.maxEntries || Object.keys(value.replies).length > limits.maxEntries
        || (value.chats !== undefined && (!value.chats || typeof value.chats !== 'object' || Array.isArray(value.chats)
          || Object.keys(value.chats).length > limits.maxEntries
          || Object.entries(value.chats).some(([chatId, row]) => !chatIdentifier(chatId)
            || !(groupChat(row?.key) === chatId || directKey(row?.key))
            || (row.name !== undefined && title(row.name) === undefined)
            || (row.registeredName !== undefined && title(row.registeredName) === undefined))))
        || Object.entries(value.bindings).some(([chatId, row]) => !chatIdentifier(chatId)
          || !identifier(row?.botId) || !identifier(row?.sessionId) || !identifier(row?.originalSessionId)
          || (row.pendingNew !== undefined && typeof row.pendingNew !== 'boolean')
          || (row.workspace !== undefined && typeof row.workspace !== 'string'))
        || Object.entries(value.replies).some(([id, row]) => !identifier(id) || typeof row?.thread !== 'boolean'
          || !Number.isSafeInteger(row.at) || row.at < 0)) throw new Error('Muse IM team bindings are invalid; the original file was preserved')
      value.chats ??= {}
      return value
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return empty()
    }
  }
  return {
    read,
    save: value => privateJson(path, value),
    rememberReply(id, thread) {
      const value = read()
      const now = Date.now()
      value.replies = Object.fromEntries(Object.entries(value.replies).filter(([, row]) => now - row.at < limits.retentionMs))
      if (!Object.hasOwn(value.replies, id) && Object.keys(value.replies).length >= limits.maxEntries) throw new Error('Muse IM reply route capacity reached')
      value.replies[id] = { thread: thread === true, at: now }
      privateJson(path, value)
    },
  }
}

/**
 * Retain native IM transport and workspace checks while registering its chat Sessions in Muse Bot.
 * @param {object} scope Native workspace-scoped Harness and state.
 * @param {object} options Registered app identity, private home, claim limits and lazy Muse team service.
 * @returns {object} Scoped Harness, state and post-authorization admission callbacks.
 */
export function createMuseImTeamScope(scope, options) {
  const { imBotId, appId, dshHome, getTeam, legacyAdmission, retentionMs, maxEntries } = options
  if (!identifier(imBotId) || !identifier(appId) || typeof getTeam !== 'function'
    || !Number.isSafeInteger(retentionMs) || retentionMs <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new TypeError('Muse IM team routing requires the registered app identity, service and positive claim limits')
  }
  const identity = { imBotId, appId }
  const hash = createHash('sha256').update(JSON.stringify([imBotId, appId])).digest('hex')
  const directory = join(dshHome, 'integrations', 'muse-team', hash)
  const path = join(directory, 'bindings.json')
  const store = bindingStore(path, identity, { retentionMs, maxEntries })
  const claims = createInboundClaims(join(directory, 'requests.json'), { retentionMs, maxEntries })
  const nameAttempts = new Set()
  const chatForKey = key => groupChat(key) ?? (directKey(key)
    ? Object.entries(store.read().chats).find(([, row]) => row.key === key)?.[0] : undefined)
  const learnChat = (event, key, { client, signal } = {}) => serial(path, async () => {
    const chatId = event.message.chat_id
    const value = store.read()
    const old = value.chats[chatId]
    if ((old && old.key !== key) || Object.entries(value.chats).some(([id, row]) => id !== chatId && row.key === key)) {
      throw failure('muse-team-chat-mismatch', 'The Feishu chat identity changed; its existing Bot was preserved')
    }
    if (!old && Object.keys(value.chats).length >= maxEntries) throw new Error('Muse IM chat capacity reached')
    let name = event.message.chat_type === 'p2p' ? title(event.sender?.sender_name) : undefined
    name ??= old?.name
    if (!name && !nameAttempts.has(chatId)) {
      nameAttempts.add(chatId)
      signal?.throwIfAborted()
      try {
        if (event.message.chat_type === 'group' && typeof client?.im?.v1?.chat?.get === 'function') {
          const result = await client.im.v1.chat.get({ path: { chat_id: chatId } }, { signal })
          if (result?.code === 0) name = title(result.data?.name)
        } else if (event.message.chat_type === 'p2p' && typeof client?.im?.v1?.message?.get === 'function') {
          const result = await client.im.v1.message.get({ path: { message_id: event.message.message_id },
            params: { with_sender_name: true } }, { signal })
          const source = result?.code === 0 && result.data?.items?.find(item => item?.message_id === event.message.message_id)
          if (source && !source.deleted && source.chat_id === chatId && source.sender?.sender_type === 'user'
            && source.sender?.id_type === 'open_id' && source.sender.id === event.sender?.sender_id?.open_id) name = title(source.sender.sender_name)
        }
      } catch (error) {
        // Optional labels never require new permissions or expose SDK credential diagnostics.
        signal?.throwIfAborted()
      }
      signal?.throwIfAborted()
    }
    value.chats[chatId] = { ...old, key, ...(name ? { name } : {}) }
    store.save(value)
  })
  const team = () => {
    const value = getTeam()
    if (!value || typeof value.registerSessionAsBot !== 'function' || typeof value.resolveCurrentSession !== 'function') {
      throw failure('muse-team-unavailable', 'Muse Bot is not available; the original Feishu Session binding was preserved')
    }
    return value
  }
  const response = value => {
    if (!identifier(value?.botId) || !identifier(value?.sessionId)) throw new Error('Muse Bot returned an invalid Session binding')
    return value
  }
  const register = (service, sessionId, chatId) => {
    const nameHint = store.read().chats[chatId]?.name
    return service.registerSessionAsBot(sessionId, nameHint ? { nameHint } : {})
  }
  const saveBinding = (chatId, selected, originalSessionId) => {
    const latest = store.read()
    latest.bindings[chatId] = { botId: selected.botId, sessionId: selected.sessionId, originalSessionId, workspace: scope.harness.currentWorkspace?.() }
    if (latest.chats[chatId]?.name) latest.chats[chatId].registeredName = latest.chats[chatId].name
    store.save(latest)
  }
  const setChat = (key, sessionId, { explicit = false } = {}) => serial(path, async () => {
    const chatId = chatForKey(key)
    const value = store.read()
    const old = value.bindings[chatId]
    const service = team()
    let selected
    if (old === undefined) selected = response(await register(service, sessionId, chatId))
    else if (sessionId === old.sessionId) selected = response(await service.resolveCurrentSession(old.botId))
    else if (explicit || old.pendingNew === true) {
      if (typeof service.switchCurrentSession !== 'function') throw failure('muse-team-switch-unavailable', 'Muse Bot cannot switch this chat Session yet; the existing Bot was preserved')
      selected = response(await service.switchCurrentSession(old.botId, sessionId))
    } else {
      selected = response(await service.resolveCurrentSession(old.botId))
      if (selected.sessionId !== sessionId) throw failure('muse-team-session-mismatch', 'The chat Session changed; no replacement Bot or model request was created')
    }
    if (old !== undefined && selected.botId !== old.botId) throw new Error('Muse Bot changed a stable Feishu chat identity')
    if (!await scope.harness.sessionExists(selected.sessionId)) throw failure('muse-team-session-workspace', 'The Muse Bot Session is outside the current Feishu workspace or unavailable')
    const committed = await scope.state.setSession(key, selected.sessionId)
    if (committed === false) return false
    saveBinding(chatId, selected, old?.originalSessionId ?? sessionId)
    return selected
  })
  const prepareChat = key => serial(path, async () => {
    const chatId = chatForKey(key)
    const value = store.read()
    const old = value.bindings[chatId]
    if (old?.pendingNew) return
    if (old?.workspace !== undefined && old.workspace !== scope.harness.currentWorkspace?.()) {
      old.pendingNew = true
      store.save(value)
      return
    }
    const source = scope.state.sessionFor(key)
    if (old === undefined && !source) return
    const selected = response(old === undefined
      ? await register(team(), source, chatId)
      : await team().resolveCurrentSession(old.botId))
    if (old !== undefined && selected.botId !== old.botId) throw new Error('Muse Bot changed a stable Feishu chat identity')
    const chat = store.read().chats[chatId]
    if (old && chat?.name && chat.name !== chat.registeredName) {
      const named = response(await register(team(), selected.sessionId, chatId))
      if (named.botId !== selected.botId || named.sessionId !== selected.sessionId) throw new Error('Muse Bot changed identity while naming a Feishu chat')
    }
    if (!await scope.harness.sessionExists(selected.sessionId)) throw failure('muse-team-session-workspace', 'The Muse Bot Session is outside the current Feishu workspace or unavailable')
    const committed = await scope.state.setSession(key, selected.sessionId)
    if (committed === false) throw failure('workspace-session-stale', 'The Feishu workspace changed before Muse Bot routing completed')
    saveBinding(chatId, selected, old?.originalSessionId ?? source)
  })
  const state = new Proxy(scope.state, {
    get(target, property) {
      if (property === 'setSession') return (key, id) => chatForKey(key) ? setChat(key, id).then(value => value === false ? false : undefined) : target.setSession(key, id)
      if (property === 'clearSession') return async key => {
        if (!chatForKey(key)) return target.clearSession(key)
        return serial(path, async () => {
          const value = store.read()
          const row = value.bindings[chatForKey(key)]
          if (row) { row.pendingNew = true; store.save(value) }
          await target.clearSession(key)
        })
      }
      if (property === 'clearSessions') return async () => serial(path, async () => {
        const value = store.read()
        for (const row of Object.values(value.bindings)) row.pendingNew = true
        store.save(value)
        return target.clearSessions()
      })
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const harness = new Proxy(scope.harness, {
    get(target, property) {
      if (property === 'createSession') return async settings => {
        const chatId = chatForKey(settings?.conversationKey)
        if (chatId) {
          const old = store.read().bindings[chatId]
          if (old && !old.pendingNew) throw failure('muse-team-session-unavailable', 'The original chat Session is unavailable; no replacement was created')
        }
        return target.createSession(settings)
      }
      if (property === 'bindWorkspaceSession') return async (key, id) => {
        const answer = await target.bindWorkspaceSession(key, id)
        if (chatForKey(key)) await setChat(key, answer.sessionId ?? id, { explicit: true })
        return answer
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const admission = {
    conversationKey(event) {
      if (!chatIdentifier(event?.message?.chat_id)) return undefined
      if (event.message.chat_type === 'group') return `group:${event.message.chat_id}`
      const key = `p2p:${event?.sender?.sender_id?.open_id}`
      return event.message.chat_type === 'p2p' && directKey(key) ? key : undefined
    },
    async message(event, nativeState, reply = {}) {
      const message = event?.message
      if (!identifier(message?.message_id)) return false
      if (claims.has(message.message_id)) return false
      if (legacyAdmission?.allowed && !legacyAdmission.allowed(event, nativeState)) return false
      const key = admission.conversationKey(event)
      if (key) {
        team()
        await learnChat(event, key, reply)
        await legacyAdmission?.prepare?.(event, nativeState)
        await prepareChat(key)
      }
      store.rememberReply(message.message_id, reply.replyInThread === true)
      if (legacyAdmission && !await legacyAdmission.message(event, nativeState)) return false
      return claims.claim(message.message_id)
    },
    rememberReply(messageId, inThread) { if (identifier(messageId)) store.rememberReply(messageId, inThread) },
    replyInThreadFor(messageId) { return store.read().replies[messageId]?.thread },
  }
  return { harness, state, admission, bindingPath: path }
}
