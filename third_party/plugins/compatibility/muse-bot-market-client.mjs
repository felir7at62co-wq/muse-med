/** Hand an already-created market Session to the native Muse Bot surface. */

/** Create the desktop-only market navigation capability from native client actions. */
export function createMuseBotMarketNavigation({ surface, actions, pull, sessionOf }) {
  const getSnapshot = () => surface.getSnapshot().mode === 'bot'
  return {
    getSnapshot,
    subscribe: surface.subscribe,
    async openSession(sessionId, signal) {
      if (signal.aborted || !getSnapshot()) return false
      const result = await actions.adoptSession({ sessionId })
      if (signal.aborted || !getSnapshot()) return false
      if (result.sessionId !== sessionId) throw new Error('Muse Bot adopted a different Session')
      if (sessionOf(result.botId) === undefined) await pull()
      if (signal.aborted || !getSnapshot()) return false
      if (sessionOf(result.botId) !== sessionId) throw new Error('Muse Bot did not list the adopted Session')
      actions.openSession(result.botId)
      return true
    },
  }
}
