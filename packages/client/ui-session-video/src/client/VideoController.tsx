/** Session video inventory and visible-card detection, independent of presentation. */
import { useEffect } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { VideoShared } from './face.ts'

type Props = PropsRuntime<'conversation.session.header.utilities'> & VideoShared & {
  readonly onLoadError: (failed: boolean | null) => void
}

/** Keep one Session inventory and detection queue while its header is mounted.
 * @param props - Session state, video queries, shared store and inventory status.
 * @returns No visible content.
 */
export function VideoController({ useStore, actions, sessionId, useSession, useChat, listVideos, detectShots, onLoadError }: Props) {
  const sources = useStore(state => state.sources)
  const analyses = useStore(state => state.analyses)
  const observed = useStore(state => state.observed)
  const detectErrors = useStore(state => state.detectErrors)
  const inventoryRevision = useStore(state => state.inventoryRevision)
  const running = useSession(state => state.running)
  const tail = useChat(state => state.order.at(-1))
  useEffect(() => {
    const controller = new AbortController()
    onLoadError(null)
    void listVideos(sessionId, controller.signal).then((value) => {
      if (!controller.signal.aborted) { actions.inventory(value); onLoadError(false) }
    }).catch((_error: unknown) => { if (!controller.signal.aborted) onLoadError(true) })
    return () => { controller.abort() }
  }, [sessionId, tail, running, inventoryRevision, listVideos, actions, onLoadError])
  const candidate = sources.find(item => observed[item.id] !== undefined && item.version !== null && item.playbackUrl !== null
    && (analyses[item.id]?.sourceVersion !== item.version || (item.status === 'remote-only' && analyses[item.id]?.state === 'ready'))
    && detectErrors[item.id] !== item.version)
  useEffect(() => {
    if (candidate === undefined || candidate.version === null) return
    const version = candidate.version
    const controller = new AbortController()
    void detectShots(sessionId, candidate.id, version, controller.signal).then(async (value) => {
      if (controller.signal.aborted) return
      if (candidate.status === 'remote-only') {
        try {
          const inventory = await listVideos(sessionId, controller.signal)
          controller.signal.throwIfAborted()
          if (value.state === 'ready' && !inventory.sources.some(item => item.id === candidate.id && item.version === value.sourceVersion && item.status === 'local')) {
            throw Error('Downloaded video is no longer available')
          }
          actions.inventory(inventory)
          onLoadError(false)
        } catch (_error: unknown) {
          controller.signal.throwIfAborted()
          actions.detectionFailed(candidate.id, version)
        }
      }
      controller.signal.throwIfAborted()
      actions.analysis(value)
    }).catch((_error: unknown) => {
      if (!controller.signal.aborted) actions.detectionFailed(candidate.id, version)
    })
    return () => { controller.abort() }
  }, [candidate, sessionId, detectShots, listVideos, actions, onLoadError])
  return null
}
