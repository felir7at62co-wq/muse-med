import { STORAGE } from './storage.js'
import { currentPart } from './text.js'

// The classic view may attach only the current part of the Bot being displayed.
export function classicWorkspaceTarget(currentMode, nextMode, sessionId, roster) {
  if (currentMode !== 'bot' || nextMode !== 'agent' || sessionId === undefined) return undefined
  const bot = roster.byId[sessionId]
  return bot !== undefined && currentPart(bot) === sessionId ? { botId: bot.id, sessionId } : undefined
}

// The plugin's surface mode: 'bot' paints the whole team interface over the shell,
// 'agent' withdraws every replacement so the shell's own interface comes back.
// `plain` marks a Bot-mode view whose main view is a plain session — only the
// conversation replacements come off then, the shell stays.
export function groupsFor({ mode, plain = false }) {
  return { shell: mode === 'bot', conversation: mode === 'bot' && !plain }
}

const GROUPS = ['shell', 'conversation']

// Runs every disposer even when one throws, last installed first: later entries
// lean on earlier ones (the theme's styles and tokens), never the other way round.
function disposeAll(disposers, label) {
  for (const dispose of [...disposers].reverse()) {
    try { dispose?.() } catch (error) { console.warn(`[ds-bot] ${label}`, error) }
  }
}

// Keeps the mounted groups in step with `groupsFor`. The conversation group sits on
// the shell's styles and tokens, so it comes off before the shell and goes on after.
// A group's list is cleared before it is disposed, so a throw never makes a later
// reconcile believe the group is mounted.
//
// `install[group]()` lists the group's steps; each step mounts one thing and returns
// its disposer. A group goes on whole or not at all: when a step throws, the steps
// before it are withdrawn, so Agent mode never keeps a half-installed Bot skin.
export function surfaceGroups(install, { onError } = {}) {
  const mounted = { shell: [], conversation: [] }
  const withdraw = (group) => {
    const disposers = mounted[group]
    mounted[group] = []
    disposeAll(disposers, `withdraw ${group}`)
  }
  const mount = (group) => {
    const disposers = []
    try {
      for (const step of install[group]()) if (step) disposers.push(step())
      mounted[group] = disposers
      return true
    } catch (error) {
      disposeAll(disposers, `roll back ${group}`)
      console.warn(`[ds-bot] install ${group}`, error)
      onError?.(group, error)
      return false
    }
  }
  let lastWanted = {}
  const api = {
    reconcile(wanted) {
      lastWanted = wanted
      for (const group of [...GROUPS].reverse()) if (!wanted[group]) withdraw(group)
      for (const group of GROUPS) {
        if (!wanted[group] || mounted[group].length > 0) continue
        if (!mount(group)) break
      }
    },
    // A step can go on with nothing actually contributed — a slot inject whose
    // callback threw inside the host still returns its disposer. remount takes
    // the group off and lets the reconcile put it back, so a caller that
    // notices the contribution is missing can retry instead of trusting
    // `mounted`. Groups that lean on it (the conversation on the shell's
    // styles) come off first and go back only through the reconcile — a
    // failed remount never leaves one stranded.
    remount(group, wanted = lastWanted) {
      if (!GROUPS.includes(group)) return
      for (const later of GROUPS.slice(GROUPS.indexOf(group) + 1)) withdraw(later)
      withdraw(group)
      api.reconcile(wanted)
    },
    dispose() { for (const group of [...GROUPS].reverse()) withdraw(group) },
  }
  return api
}

// The priority that puts an entry below every other entry of its cell (lowest
// renders). Another plugin that shadows the same cell at the same priority would
// make the registration throw; in a Bot surface the cell is DS Bot's.
export function freePriority(entries, { priority, key, id }) {
  if (priority === undefined) return undefined
  const taken = entries
    .filter(entry => (key === undefined || entry.options?.key === key) && (id === undefined || entry.options?.id === id))
    .map(entry => (entry.options?.priority ?? 0) - 1)
  return Math.min(priority, ...taken)
}

export function readMode(storage = globalThis.localStorage) {
  try { return storage.getItem(STORAGE.surface) === 'agent' ? 'agent' : 'bot' } catch { return 'bot' }
}

export function writeMode(mode, storage = globalThis.localStorage) {
  try { storage.setItem(STORAGE.surface, mode) } catch { /* storage unavailable */ }
}

// Reuse needs a complete Host ownership list; an unresolved roster still allows
// the Workspace service to create a fresh ordinary Session.
export function canReuseOrdinarySession(sessionId, roster) {
  return roster.ready === true && Array.isArray(roster.ownedSessionIds) && !roster.ownedSessionIds.includes(sessionId)
}

// Each surface remembers only its own visible Session. Switching never updates a
// model, copies a draft, or interrupts the Session left behind.
export function surfaceSelections(storage = globalThis.localStorage) {
  let kept = {}
  try {
    const value = JSON.parse(storage.getItem(STORAGE.surfaceSelections) ?? '{}')
    if (value && typeof value === 'object') {
      for (const mode of ['agent', 'bot']) if (typeof value[mode] === 'string') kept[mode] = value[mode]
    }
  } catch { /* storage unavailable or unreadable */ }
  const botSession = (id, roster) => roster.byId?.[id] !== undefined || roster.roomsById?.[id] !== undefined
  return {
    remember(mode, id, roster) {
      if (typeof id !== 'string' || (mode !== 'agent' && mode !== 'bot')) return
      if (botSession(id, roster) !== (mode === 'bot')) return
      kept[mode] = id
      try { storage.setItem(STORAGE.surfaceSelections, JSON.stringify(kept)) } catch { /* storage unavailable */ }
    },
    target(mode, list, roster) {
      if (mode === 'bot') {
        const bot = roster.byId?.[kept.bot]
        if (bot) return currentPart(bot)
        if (roster.roomsById?.[kept.bot]) return kept.bot
        const main = roster.byId?.[roster.mainBotId] ?? roster.bots?.[0]
        return main ? currentPart(main) : roster.rooms?.[0]?.id
      }
      if (list.byId?.[kept.agent] && !botSession(kept.agent, roster)) return kept.agent
      return Object.values(list.byId ?? {}).filter(row => row?.origin !== 'subagent' && !botSession(row.id, roster))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]?.id
    },
  }
}

// Creates a fresh ordinary Session once while navigation is pending. Leaving the
// surface or opening another Session prevents late navigation; creation is retained.
export function ordinarySessionStarter({ create, open, current, isActive, remember }) {
  let pending
  let navigate = false
  let disposed = false
  let from
  return {
    start(workspaceId) {
      if (disposed) return Promise.resolve(undefined)
      navigate = true
      from = current()
      if (pending) return pending
      pending = Promise.resolve().then(() => create({ workspaceId })).then((id) => {
        if (!disposed) {
          remember(id)
          if (navigate && isActive() && current() === from) open(id)
        }
        return id
      }).finally(() => { pending = undefined })
      return pending
    },
    cancel() { navigate = false },
    dispose() { disposed = true; navigate = false },
  }
}
