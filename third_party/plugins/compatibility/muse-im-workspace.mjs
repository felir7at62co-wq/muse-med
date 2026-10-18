/** One selected workspace per Feishu bot, with an independent Session for each chat. */
import { createBotWorkspaceScope } from '../src/channels/shared/bot-workspace-store.mjs'
import { sameWorkspacePath } from '../src/channels/shared/default-workspace.mjs'
import { WORKSPACE_SESSION_STALE } from '../src/channels/shared/workspace-session.mjs'
import { getImHostLanguage } from '../src/channels/shared/i18n.mjs'

const messages = {
  zh: {
    'muse-workspace-session-in-use': '该会话已被另一个飞书聊天使用。请选择其他会话，保留各聊天独立的记录。',
    'muse-workspace-session-foreign': '该会话不在机器人当前工作区中。请先在机器人卡片中切换工作区，再选择会话；私聊和群聊将共同跟随所选目录。',
    'muse-workspace-session-unavailable': '暂时无法核实该会话的工作区，已保留原聊天绑定，请稍后重试。',
  },
  en: {
    'muse-workspace-session-in-use': 'Another Feishu chat already uses this Session. Choose another Session to keep chat histories independent.',
    'muse-workspace-session-foreign': 'This Session is outside the bot workspace. Select its workspace in the bot card first; private and group chats will follow that directory.',
    'muse-workspace-session-unavailable': 'The Session workspace could not be verified. Its existing chat binding was preserved; try again later.',
  },
}

const workspaceMessages = {
  zh: {
    status: '同一机器人的私聊和群聊共用所选工作区，聊天记录各自独立。',
    switched: '机器人工作区已切换为：{workspace}（此机器人的私聊和群聊都会跟随）。',
    clear: '当前继续使用机器人所选工作区：{workspace}（私聊和群聊共用）。',
  },
  en: {
    status: 'Private and group chats with this bot share the selected workspace while keeping separate chat histories.',
    switched: 'Bot workspace changed to: {workspace} (all private and group chats with this bot follow this selection).',
    clear: 'Continuing with the selected bot workspace: {workspace} (shared by private and group chats).',
  },
}

function failure(code, message) {
  return Object.assign(new Error(messages[getImHostLanguage()][code] ?? message), { code })
}

/**
 * Apply Feishu's shared-directory policy through the upstream queues and Session fences.
 * @param {object} harness The production Harness client.
 * @param {object} options Bot stores, preset catalog and an authoritative Session-header cwd reader.
 * @returns {Promise<object>} Scoped Harness and state; existing logs and workspace files stay in place.
 */
export async function createMuseImWorkspaceScope(harness, options) {
  const { botId, workspaces, state, readSessionWorkspace } = options
  if (typeof readSessionWorkspace !== 'function') throw new TypeError('A Session workspace reader is required')
  const generation = () => workspaces.generationFor(botId)
  const stale = () => failure(WORKSPACE_SESSION_STALE, 'The bot workspace changed before the Session operation completed')
  const matches = async sessionId => {
    const cwd = await readSessionWorkspace(sessionId)
    if (!cwd) throw failure('muse-workspace-session-unavailable', 'The Session workspace could not be verified; its chat binding was preserved')
    return sameWorkspacePath(cwd, workspaces.workspaceFor(botId))
  }
  const assertUnique = (key, sessionId) => {
    if (Object.entries(state.snapshot().sessions).some(([other, id]) => other !== key && id === sessionId)) {
      throw failure('muse-workspace-session-in-use', 'This Session is already bound to another Feishu chat')
    }
  }
  const guardedState = new Proxy(state, {
    get(target, property) {
      if (property === 'setSession') return (key, sessionId) => {
        assertUnique(key, sessionId)
        return target.setSession(key, sessionId)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const sharedWorkspaces = new Proxy(workspaces, {
    get(target, property) {
      if (property === 'conversationWorkspaceFor') return id => target.workspaceFor(id)
      if (property === 'hasConversationWorkspaceOverride') return () => false
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const guardedHarness = new Proxy(harness, {
    get(target, property) {
      if (property === 'createSession') return async settings => {
        const before = generation()
        const sessionId = await target.createSession(settings)
        if (generation() !== before || !await matches(sessionId) || generation() !== before) throw stale()
        return sessionId
      }
      if (property === 'sessionExists') return async (sessionId, ...args) => {
        const before = generation()
        if (!await matches(sessionId) || generation() !== before) return false
        const exists = await target.sessionExists(sessionId, ...args)
        return generation() === before && exists
      }
      if (property === 'ask') return async (sessionId, ...args) => {
        const before = generation()
        if (!await matches(sessionId) || generation() !== before) throw stale()
        return target.ask(sessionId, ...args)
      }
      if (property === 'adoptWorkspaceSession') return async (sessionId, ...args) => {
        const before = generation()
        if (!await matches(sessionId)) {
          throw failure('muse-workspace-session-foreign', 'Select the bot workspace before binding a Session from that directory')
        }
        if (generation() !== before) throw stale()
        const adopted = await target.adoptWorkspaceSession(sessionId, ...args)
        if (generation() !== before) throw stale()
        if (!await sameWorkspacePath(adopted.workspace, workspaces.workspaceFor(botId))) {
          throw failure('muse-workspace-session-foreign', 'The selected Session belongs to another workspace')
        }
        if (generation() !== before) throw stale()
        return adopted
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const scope = createBotWorkspaceScope(guardedHarness, { ...options, workspaces: sharedWorkspaces, state: guardedState })
  return { state: scope.state, harness: new Proxy(scope.harness, {
    get(target, property) {
      if (property === 'workspaceScope') return 'bot'
      if (property === 'sharedWorkspaceMessage') return (kind, workspace) => workspaceMessages[getImHostLanguage()][kind].replace('{workspace}', () => workspace)
      if (property === 'switchConversationWorkspace') return (_key, workspace) => target.switchWorkspace(workspace)
      if (property === 'clearConversationWorkspace') return async () => target.currentWorkspace()
      if (property === 'bindWorkspaceSession') return (key, sessionId) => {
        assertUnique(key, sessionId)
        return target.bindWorkspaceSession(key, sessionId)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) }
}
