/** Fixed native-record requests to an embedding Muse panel; standalone pages cannot dispatch chat. */
const requiredIntents = ['inspect_project', 'inspect_package', 'inspect_operation', 'propose_fix', 'continue_production']
const intents = [...requiredIntents, 'inspect_assets']
const outcomes = ['received', 'draft_prepared', 'sent', 'cancelled', 'failed', 'unavailable']
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(value)
const positive = value => Number.isSafeInteger(value) && value > 0
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function validSelection(value) {
  if (!object(value) || !positive(value.projectId)
    || Object.keys(value).some(key => !['projectId', 'episodeId', 'storyboardId', 'kind', 'generationId', 'operationId', 'workflowId'].includes(key))) return false
  for (const key of ['episodeId', 'storyboardId', 'generationId']) if (key in value && !positive(value[key])) return false
  for (const key of ['operationId', 'workflowId']) if (key in value && !token(value[key])) return false
  if ('kind' in value && !['image', 'video', 'audio'].includes(value.kind)) return false
  return value.generationId === undefined || value.kind !== undefined
}

/**
 * Own a reversible parent handshake and one pending fixed request.
 * @param options - State callback owned by the mounted studio page.
 * @returns Start/stop, fixed-request submission and a detached public state snapshot.
 */
export function createMuseStudioBridge({ onState = () => {} } = {}) {
  let started = false, parentOrigin, nonce, pending
  let state = { available: false, pending: false, outcome: null, intents: [] }
  const snapshot = () => ({ ...state, intents: [...state.intents] })
  const publish = patch => { state = { ...state, ...patch }; onState(snapshot()) }
  const receive = event => {
    if (!started || window.parent === window || event.source !== window.parent || event.origin === 'null'
      || (event.origin !== 'dsh-app://app' && event.origin !== window.location.origin) || !object(event.data)) return
    const data = event.data
    if (data.version !== 1 || (parentOrigin && parentOrigin !== event.origin)) return
    if (data.type === 'muse-localminidrama:capabilities' && token(data.nonce) && typeof data.available === 'boolean'
      && Array.isArray(data.intents) && requiredIntents.every(intent => data.intents.includes(intent))) {
      parentOrigin = event.origin
      if (nonce !== data.nonce || !data.available) pending = undefined
      nonce = data.nonce
      publish({ available: data.available, pending: pending !== undefined, intents: intents.filter(intent => data.intents.includes(intent)) })
    } else if (data.type === 'muse-localminidrama:intent-result' && pending && data.nonce === pending.nonce
      && data.requestId === pending.requestId && outcomes.includes(data.outcome)) {
      const waiting = data.outcome === 'received'
      if (!waiting) pending = undefined
      publish({ pending: waiting, outcome: data.outcome })
    }
  }
  return {
    start() {
      if (started) return
      started = true
      if (window.parent === window) { publish({ available: false, pending: false, outcome: 'unavailable' }); return }
      window.addEventListener('message', receive)
      window.parent.postMessage({ type: 'muse-localminidrama:bridge-hello', version: 1 }, '*')
    },
    stop() {
      if (!started) return
      started = false; window.removeEventListener('message', receive)
      parentOrigin = undefined; nonce = undefined; pending = undefined
      publish({ available: false, pending: false, intents: [] })
    },
    request(intent, selection) {
      if (!started || !state.available || pending || !parentOrigin || !nonce || !state.intents.includes(intent) || !validSelection(selection)
        || (intent === 'inspect_package' && selection.episodeId === undefined)
        || (intent === 'inspect_operation' && selection.operationId === undefined && selection.generationId === undefined)) return false
      const bytes = window.crypto.getRandomValues(new Uint8Array(16))
      const requestId = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
      pending = { type: 'muse-localminidrama:intent', version: 1, nonce, requestId, intent, selection: { ...selection } }
      publish({ pending: true, outcome: null })
      window.parent.postMessage(pending, parentOrigin)
      return true
    },
    snapshot,
  }
}
