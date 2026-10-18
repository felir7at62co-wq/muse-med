/** Import the previous Muse Feishu account without changing its source files. */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const operations = new Map()
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const identityOf = config => createHash('sha256').update(JSON.stringify([config.appId, config.registeredBy ?? ''])).digest('hex')

function pathsFor(config) {
  for (const key of ['dshHome', 'dataDir', 'feishuDataDir', 'defaultCwd']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !isAbsolute(config[key]))) {
      throw new Error('Muse IM migration data and workspace paths must be absolute')
    }
  }
  const home = resolve(config.dshHome ?? process.env.DSH_HOME ?? process.env.MUSE_HOME ?? join(homedir(), '.muse'))
  const root = resolve(config.feishuDataDir ?? join(home, 'integrations', 'dsh-feishu'))
  const identity = identityOf(config)
  const legacy = join(config.dataDir ?? join(home, 'feishu'), 'accounts', identity)
  const botId = `bot_muse_${identity.slice(0, 24)}`
  return { home, root, legacy, identity, botId,
    marker: join(root, `muse-migration-${identity}.json`),
    claims: join(root, 'bots', botId, 'muse-inbound-claims.json'),
    state: join(root, 'bots', botId, 'state.json'),
    workspace: config.defaultCwd ?? join(home, 'default-workspace') }
}

async function readJson(file) {
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Muse IM migration requires regular files')
    try { return JSON.parse(await readFile(file, 'utf8')) } catch (_error) {
      throw new Error('Muse IM migration data is not valid JSON')
    }
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Muse IM migration directory must not be a link')
  await chmod(directory, 0o700)
}

async function writeJson(file, value) {
  await privateDirectory(dirname(file))
  const temporary = `${file}.${randomUUID()}.tmp`
  let handle
  let published = false
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, file)
    published = true
  } finally {
    await handle?.close()
    if (!published) {
      try { await unlink(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
}

async function backupFile(file) {
  const original = await readFile(file)
  const backup = `${file}.muse-bot-workspace.${randomUUID()}.bak`
  const handle = await open(backup, 'wx', 0o600)
  try {
    await handle.writeFile(original)
    await handle.sync()
  } finally { await handle.close() }
  return backup
}

async function stores() {
  const [{ PluginConfigStore }, { BotWorkspaceStore }, { StateStore }, { sameWorkspacePath }] = await Promise.all([
    import('../src/channels/feishu/plugin-config-store.mjs'),
    import('../src/channels/shared/bot-workspace-store.mjs'),
    import('../src/channels/feishu/state-store.mjs'),
    import('../src/channels/shared/default-workspace.mjs'),
  ])
  return { PluginConfigStore, BotWorkspaceStore, StateStore, sameWorkspacePath }
}

async function sessionHeader(ctx, sessionId) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions
  const live = sessions?.get(sessionId)
  if (live?.header?.id === sessionId) return live.header
  const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : ctx.sessionPersistence
  const snapshot = await persistence?.stat(sessionId)
  return snapshot?.header?.id === sessionId ? snapshot.header : undefined
}

/** Remove old per-chat routing before native stores mount; Session histories remain untouched. */
async function followBotWorkspace(ctx, paths) {
  const result = { botId: paths.botId, removedOverrides: [], detachedSessions: [], backups: [] }
  const workspacePath = join(paths.root, 'workspaces.json')
  const document = await readJson(workspacePath)
  if (document === undefined) return result
  if (!record(document) || !record(document.workspaces)) {
    throw new Error('Muse IM migration destination workspace is invalid')
  }
  if (!Object.hasOwn(document.workspaces, paths.botId)) return result
  const workspace = document.workspaces[paths.botId]
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) throw new Error('Muse IM migration destination workspace is invalid')
  const isFeishuKey = key => /^(?:p2p|group):/u.test(key)
  const overrides = document.conversationWorkspaces?.[paths.botId]
  const overrideKeys = record(overrides) ? Object.keys(overrides).filter(isFeishuKey) : []
  const state = await readJson(paths.state)
  if (state !== undefined && (!record(state) || !record(state.sessions)
    || Object.values(state.sessions).some(id => typeof id !== 'string' || !id))) {
    throw new Error('Muse IM migration destination state is invalid')
  }
  const { sameWorkspacePath } = await stores()
  const detached = []
  for (const [key, id] of Object.entries(state?.sessions ?? {})) {
    if (!isFeishuKey(key)) continue
    const header = await sessionHeader(ctx, id)
    if (typeof header?.cwd === 'string' && isAbsolute(header.cwd) && !await sameWorkspacePath(header.cwd, workspace)) detached.push(key)
  }
  if (overrideKeys.length > 0) {
    result.backups.push(await backupFile(workspacePath))
    for (const key of overrideKeys) delete overrides[key]
    if (Object.keys(overrides).length === 0) delete document.conversationWorkspaces[paths.botId]
    if (Object.keys(document.conversationWorkspaces).length === 0) delete document.conversationWorkspaces
    await writeJson(workspacePath, document)
    result.removedOverrides = overrideKeys
  }
  if (detached.length > 0) {
    result.backups.push(await backupFile(paths.state))
    for (const key of detached) delete state.sessions[key]
    await writeJson(paths.state, state)
    result.detachedSessions = detached
  }
  return result
}

function serialize(key, operation) {
  const pending = (operations.get(key) ?? Promise.resolve()).then(operation)
  const settled = pending.then(() => undefined, () => undefined)
  operations.set(key, settled)
  settled.then(() => { if (operations.get(key) === settled) operations.delete(key) })
  return pending
}

function policyFor(config) {
  const allowed = [...new Set(config.allowFrom ?? [])]
  const ownerOpenIds = [...new Set([config.registeredBy, ...allowed].filter(id => typeof id === 'string' && /^ou_[A-Za-z0-9_-]+$/u.test(id)))]
  const allowedChatIds = allowed.filter(id => /^oc_[A-Za-z0-9_-]+$/u.test(id))
  if (ownerOpenIds.length === 0) throw new Error('Muse IM migration requires a known owner; access remains closed')
  return { ownerOpenIds, allowedChatIds }
}

function accessPolicy(ownerOpenIds) {
  const scope = (mode, users) => ({ mode,
    open: { defaultCanExecuteCommands: false, commandPermissionOverrides: ownerOpenIds.map(id => ({ id, canExecuteCommands: true })) },
    allowlist: { users: users.map(id => ({ id, canExecuteCommands: true })) } })
  // The wrapper separately limits groups by their chat id; people in an allowed group keep their previous access.
  return { direct: scope('allowlist', ownerOpenIds), group: scope('open', []) }
}

function validateLegacy(map, claims) {
  if (map !== undefined && (!record(map) || ![1, 2].includes(map.version) || !record(map.entries)
    || Object.entries(map.entries).some(([chat, session]) => !/^oc_[A-Za-z0-9_-]+$/u.test(chat) || typeof session !== 'string' || !session)
    || new Set(Object.values(map.entries)).size !== Object.keys(map.entries).length
    || (map.cwds !== undefined && (!record(map.cwds) || Object.values(map.cwds).some(cwd => typeof cwd !== 'string' || !isAbsolute(cwd)))))) {
    throw new Error('Muse IM legacy session map is invalid')
  }
  if (claims !== undefined && (!record(claims) || claims.version !== 1 || !Array.isArray(claims.entries)
    || claims.entries.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[0]
      || !Number.isSafeInteger(row[1]) || row[1] < 0)
    || new Set(claims.entries.map(row => row[0])).size !== claims.entries.length)) {
    throw new Error('Muse IM legacy message claims are invalid')
  }
}

function publicResult(marker, paths, status = marker.phase === 'complete' ? 'migrated' : 'pending') {
  if (status === 'removed') return { status }
  return { status, botId: marker.botId, botOpenId: marker.botOpenId, ownerOpenIds: marker.ownerOpenIds, allowedChatIds: marker.allowedChatIds,
    allowedDirectIds: marker.ownerOpenIds, legacyMessageIds: marker.legacyMessageIds,
    claimsPath: paths.claims, markerPath: paths.marker,
    pendingDirectBindings: marker.pendingDirectBindings }
}

async function verifyIdentity(config, verifyApp) {
  if (verifyApp !== undefined) return verifyApp({ appId: config.appId, appSecret: config.appSecret, domain: 'feishu' })
  const [{ verifyFeishuApp }, sdk] = await Promise.all([
    import('../src/channels/feishu/feishu-app.mjs'), import('@larksuiteoapi/node-sdk'),
  ])
  return verifyFeishuApp({ appId: config.appId, appSecret: config.appSecret, domain: 'feishu', httpInstance: sdk.defaultHttpInstance })
}

async function migrate(ctx, config, paths, ports) {
  const { PluginConfigStore, BotWorkspaceStore } = await stores()
  const configStore = await new PluginConfigStore(join(paths.root, 'config.json')).load()
  const previous = await readJson(paths.marker)
  if (previous !== undefined && (previous.version !== 1 || previous.identity !== paths.identity
    || previous.botId !== paths.botId || !['prepared', 'complete'].includes(previous.phase)
    || !Array.isArray(previous.ownerOpenIds) || !Array.isArray(previous.allowedChatIds)
    || previous.ownerOpenIds.length === 0 || previous.ownerOpenIds.some(id => typeof id !== 'string' || !/^ou_[A-Za-z0-9_-]+$/u.test(id))
    || previous.allowedChatIds.some(id => typeof id !== 'string' || !/^oc_[A-Za-z0-9_-]+$/u.test(id))
    || !Array.isArray(previous.legacyMessageIds) || previous.legacyMessageIds.some(id => typeof id !== 'string' || !id)
    || typeof previous.botOpenId !== 'string' || !/^ou_[A-Za-z0-9_-]+$/u.test(previous.botOpenId)
    || !record(previous.pendingDirectBindings)
    || Object.entries(previous.pendingDirectBindings).some(([chatId, entry]) => !/^oc_[A-Za-z0-9_-]+$/u.test(chatId)
      || !record(entry) || typeof entry.sessionId !== 'string' || !entry.sessionId || typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd)))) {
    throw new Error('Muse IM migration marker is invalid')
  }
  const existing = configStore.list().find(bot => bot.appId === config.appId)
  if (previous?.phase === 'complete') {
    return publicResult(previous, paths, existing?.id === paths.botId ? 'migrated' : 'removed')
  }
  if (config.enabled === false && previous === undefined) return { status: 'disabled' }
  if (existing && !(previous?.phase === 'prepared' && existing.id === paths.botId)) {
    return { status: 'existing' }
  }
  if (!config.appSecret) throw new Error('Muse IM migration requires the existing account credential')
  const { ownerOpenIds, allowedChatIds } = policyFor(config)
  if (previous && (JSON.stringify([...previous.ownerOpenIds].sort()) !== JSON.stringify([...ownerOpenIds].sort())
    || JSON.stringify([...previous.allowedChatIds].sort()) !== JSON.stringify([...allowedChatIds].sort()))) {
    throw new Error('Muse IM account access changed during an incomplete migration; access remains closed')
  }
  const [map, claims] = await Promise.all([
    readJson(join(paths.legacy, 'session-map.json')),
    readJson(join(paths.legacy, 'inbound-claims.json')),
  ])
  validateLegacy(map, claims)
  if (!isAbsolute(paths.workspace)) throw new Error('Muse IM migration workspace must be absolute')
  let verified
  if (previous === undefined) {
    try { verified = await verifyIdentity(config, ports.verifyApp) } catch (_error) {
      throw new Error('Muse IM migration could not verify the existing Feishu bot identity')
    }
    if (typeof verified?.openId !== 'string' || !/^ou_[A-Za-z0-9_-]+$/u.test(verified.openId)) {
      throw new Error('Muse IM migration requires a verified bot open ID for exact mentions')
    }
  }
  const marker = previous ?? { version: 1, phase: 'prepared', identity: paths.identity, botId: paths.botId,
    botOpenId: verified.openId, botName: typeof verified.name === 'string' ? verified.name : 'Muse',
    ownerOpenIds, allowedChatIds, legacyMessageIds: (claims?.entries ?? []).map(row => row[0]),
    pendingDirectBindings: Object.fromEntries(Object.entries(map?.entries ?? {})
      .filter(([chat]) => !allowedChatIds.includes(chat)).map(([chatId, sessionId]) => [chatId,
        { sessionId, cwd: map?.cwds?.[chatId] ?? paths.workspace }])) }
  await privateDirectory(paths.root)
  if (previous === undefined) await writeJson(paths.marker, marker)

  const secretRef = `MUSE_IM_FEISHU_APP_SECRET_${paths.identity.toUpperCase()}`
  const credential = await ctx.credentials.resolve(secretRef)
  if (credential !== undefined && credential.value !== config.appSecret) {
    throw new Error('Muse IM migration will not replace a different existing credential')
  }
  if (credential === undefined) await ctx.credentials.set(secretRef, config.appSecret)
  if ((await ctx.credentials.resolve(secretRef))?.value !== config.appSecret) {
    throw new Error('Muse IM migration credential could not be confirmed')
  }

  const currentClaims = await readJson(paths.claims)
  validateLegacy(undefined, currentClaims)
  if (currentClaims === undefined) {
    await writeJson(paths.claims, { version: 1, entries: claims?.entries ?? [] })
  }
  const state = await readJson(paths.state)
  if (state !== undefined && (!record(state) || !record(state.sessions) || !Array.isArray(state.seenMessageIds))) {
    throw new Error('Muse IM migration destination state is invalid')
  }
  const sessions = { ...(state?.sessions ?? {}) }
  for (const chat of marker.allowedChatIds) {
    if (map?.entries?.[chat] && !Object.hasOwn(sessions, `group:${chat}`)) sessions[`group:${chat}`] = map.entries[chat]
  }
  // Upstream StateStore retains 1000 recent ids; the admission ledger above retains every imported claim.
  const seen = [...new Set([...(claims?.entries ?? []).map(row => row[0]), ...(state?.seenMessageIds ?? [])])].slice(-1000)
  await writeJson(paths.state, { version: 1, watches: {}, deferred: {}, topics: {}, mirrors: {},
    includeArchivedSessions: false, ...state, sessions, seenMessageIds: seen })

  const workspaceStore = await new BotWorkspaceStore(join(paths.root, 'workspaces.json'), { defaultWorkspace: paths.workspace }).load()
  const workspaceDocument = await readJson(join(paths.root, 'workspaces.json'))
  await workspaceStore.ensure(paths.botId, { workspace: paths.workspace, defaultAgentPreset: config.agentPreset ?? 'short-drama',
    initialAccessPolicy: accessPolicy(marker.ownerOpenIds) })
  if (!Object.hasOwn(workspaceDocument?.busyMessageModes ?? {}, paths.botId)) await workspaceStore.setBusyMessageMode(paths.botId, 'steer')
  if (!existing) await configStore.saveBot({ id: paths.botId, appId: config.appId, secretRef,
    ownerOpenIds: marker.ownerOpenIds, domain: 'feishu', botName: marker.botName, botOpenId: marker.botOpenId,
    groupResponseMode: 'mention', mentionTopicReply: false, stepPush: true, stepPushMode: 'streaming_card' })
  marker.phase = 'complete'
  await writeJson(paths.marker, marker)
  return publicResult(marker, paths)
}

/**
 * Import one configured Muse account before starting the new channel; existing native bots are not replaced.
 * @param {object} ctx Host credentials and optional live/persisted Session metadata providers.
 * @param {{appId: string, appSecret: string, enabled?: boolean, registeredBy?: string, allowFrom?: string[], agentPreset?: string, defaultCwd?: string, dataDir?: string, dshHome?: string, feishuDataDir?: string}} config Resolved existing settings and private data locations.
 * @param {{verifyApp?: Function}} [ports] Optional same-API bot verification port; production uses the official SDK transport.
 * @returns {Promise<object>} Migration identity and chat guard policy; claimsPath holds all old message claims.
 */
export async function migrateMuseIm(ctx, config, ports = {}) {
  if (!config.appId) return { status: 'not-configured' }
  const paths = pathsFor(config)
  return serialize(paths.root, () => migrate(ctx, config, paths, ports))
}

/**
 * Reconcile Feishu routing while the native channel is stopped; per-chat histories stay separate.
 * Every configured Feishu bot follows its selected workspace. Changed routing files receive
 * private original-byte backups; only active bindings with a proven foreign cwd are detached.
 * Unknown Session metadata leaves the binding untouched for runtime admission to reject.
 * @param {object} ctx Host live/persisted Session metadata providers.
 * @param {{dshHome?: string, feishuDataDir?: string}} config Absolute native data root overrides, identical to migrateMuseIm.
 * @returns {Promise<object[]>} Per-bot removed override keys, detached binding keys and backup paths.
 */
export async function reconcileMuseImWorkspaces(ctx, config) {
  const paths = pathsFor(config)
  return serialize(paths.root, async () => {
    const { PluginConfigStore } = await stores()
    const bots = (await new PluginConfigStore(join(paths.root, 'config.json')).load()).list()
    const results = []
    for (const bot of bots) results.push(await followBotWorkspace(ctx, {
      ...paths, botId: bot.id, state: join(paths.root, 'bots', bot.id, 'state.json'),
    }))
    return results
  })
}

/**
 * Bind an old direct-chat mapping only after a real, authorized incoming event proves its peer.
 * @param {object} config The same resolved account and paths supplied to migrateMuseIm.
 * @param {{chatId: string, senderOpenId: string}} event Authorized private-chat identity from the platform.
 * @param {object} [stateStore] The active channel's StateStore, so a live bridge observes the binding immediately.
 * @param {object} [workspaceStore] The active bot workspace registry when already mounted.
 * @returns {Promise<boolean>} Whether this exact original chat supplied a restorable binding.
 */
export async function bindMuseImDirectSession(config, event, stateStore, workspaceStore) {
  const paths = pathsFor(config)
  return serialize(paths.root, async () => {
    const marker = await readJson(paths.marker)
    if (marker?.phase !== 'complete' || !marker.ownerOpenIds?.includes(event.senderOpenId)) return false
    const binding = marker.pendingDirectBindings?.[event.chatId]
    if (!binding) return false
    const { StateStore, BotWorkspaceStore, sameWorkspacePath } = await stores()
    const state = stateStore ?? await new StateStore(paths.state).load()
    const key = `p2p:${event.senderOpenId}`
    if (state.sessionFor(key) && state.sessionFor(key) !== binding.sessionId) return false
    if (Object.entries(state.snapshot().sessions).some(([other, id]) => other !== key && id === binding.sessionId)) return false
    const workspace = workspaceStore ?? await new BotWorkspaceStore(join(paths.root, 'workspaces.json'), { defaultWorkspace: paths.workspace }).load()
    if (!await sameWorkspacePath(binding.cwd, workspace.workspaceFor(paths.botId))) return false
    await state.setSession(key, binding.sessionId)
    delete marker.pendingDirectBindings[event.chatId]
    await writeJson(paths.marker, marker)
    return true
  })
}
