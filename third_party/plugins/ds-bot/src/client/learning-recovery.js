import { createSource } from './sources.js'

/**
 * Retains reviewable failed answers until this client plugin owner is disposed.
 * @param send Sends a proposal id and decision with the owner's cancellation signal.
 * @returns Observable approval state, an answer action and a draining disposer.
 */
export function createLearningRecovery(send) {
  const state = createSource({})
  const pending = new Map()
  const controller = new AbortController()
  let disposed = false
  let disposal
  const close = id => state.set(current => ({ ...current, [id]: { status: 'closed' } }))
  return {
    state,
    answer(proposal, approve) {
      if (disposed) return Promise.resolve()
      const existing = pending.get(proposal.id)
      if (existing) return existing
      state.set(current => ({ ...current, [proposal.id]: { status: 'answering', proposal } }))
      const task = Promise.resolve().then(() => {
        if (!disposed) return send(proposal.id, approve, controller.signal)
      }).then(() => {
        if (!disposed) close(proposal.id)
      }, error => {
        if (disposed) return
        if (error?.code === 'bot/stale') close(proposal.id)
        else state.set(current => ({ ...current, [proposal.id]: { status: 'failed', proposal, error: error?.message ?? String(error) } }))
      })
      pending.set(proposal.id, task)
      void task.then(() => pending.delete(proposal.id))
      return task
    },
    dispose() {
      if (disposal) return disposal
      disposed = true
      controller.abort()
      state.set({})
      disposal = Promise.all([...pending.values()]).then(() => {})
      return disposal
    },
  }
}
