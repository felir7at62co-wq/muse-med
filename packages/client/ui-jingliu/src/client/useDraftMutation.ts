/** Driver for a single draft form or episode mutation. */
import { useRef, useState } from 'react'

interface MutationState {
  busy: boolean
  problem: 'failed' | 'conflict' | null
  reset: () => void
  run(action: () => Promise<void>): Promise<void>
}

/**
 * Allow one mutation at a time and keep revision conflicts visible until the user rereads the draft.
 * @returns The request status and the mutation runner.
 */
export function useDraftMutation(): MutationState {
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<MutationState['problem']>(null)
  return { busy, problem, reset: () => { setProblem(null) }, run: async (action) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setProblem(null)
    try { await action() }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      setProblem(code === 'SCRIPT_EDITOR_VERSION_CHANGED' || code === 'SCRIPT_EDITOR_CANDIDATE_CHANGED' ? 'conflict' : 'failed')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  } }
}
