/** Versioned media coordinates shared by selection and resource tests. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionVideoInventory, SessionVideoShotId, SessionVideoSource, SessionVideoSourceId } from '@deepseek-ai/dsh-session-video/types'
import type { VideoTarget } from '../src/client/target-selection.ts'

export const sessionId = brandString<SessionId>('video-workspace-selection')
export function source(id = 'first'): SessionVideoSource {
  return { id: brandString<SessionVideoSourceId>(id), version: 'v1', label: `Video ${id}`, origin: 'generated',
    path: `/project/${id}.mp4`, remoteUrl: null, playbackUrl: `/api/session-video?source=${id}`, eventSeq: 3,
    presentedIndex: null, callId: `call-${id}`, status: 'local', issue: null }
}
export function inventory(sources: readonly SessionVideoSource[] = [source()]): SessionVideoInventory {
  return { sessionId, sources, complete: true, issues: [] }
}
export function whole(item = source()): Extract<VideoTarget, { kind: 'source' }> {
  return { kind: 'source', sourceId: item.id, sourceVersion: 'v1' }
}
export function shot(item = source(), index = 2): Extract<VideoTarget, { kind: 'shot' }> {
  return { kind: 'shot', sourceId: item.id, sourceVersion: 'v1', shotId: brandString<SessionVideoShotId>(`${item.id}/cut-${index}`),
    startSeconds: (index - 1) * 4, endSeconds: index * 4 }
}
