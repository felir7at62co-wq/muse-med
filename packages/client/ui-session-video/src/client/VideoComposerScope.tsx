/** Preview context above the composer, independent of its explicit video references. */
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionVideoShotId, SessionVideoSourceId } from '@deepseek-ai/dsh-session-video/types'
import { videoShotScopeLabel } from './selection-labels.ts'
import type { VideoStore } from './store.ts'
import { videoWorkspaceAddress } from './target-selection.ts'
import { assembleTimeline, authoredShots } from './timeline.ts'
import { videoEditions } from './video-editions.ts'
import type {} from './resource-provider.ts'
import css from './VideoComposerScope.module.css'

type VideoComposerScopeProps = PropsRuntime<'conversation.input.dock'> & PropsStore<VideoStore> & PropsLocale<'sessionVideo'>

function SelectedShotScope({ sessionId, useResource, useStore, sourceId, shotId, t }:
VideoComposerScopeProps & { readonly sourceId: SessionVideoSourceId; readonly shotId: SessionVideoShotId }) {
  const inventory = useResource<'session-video'>(videoWorkspaceAddress(sessionId))
  const analysis = useStore(state => state.analyses[sourceId])
  const episode = useStore(state => state.selectedEpisode)
  const sources = inventory.value?.sources
  const source = sources?.find(item => item.id === sourceId)
  if (sources === undefined || source === undefined || source.playbackUrl === null) return null
  if (episode !== 'all' && (source.production?.episodeNumber ?? 'unassigned') !== episode) return null
  const shot = authoredShots(source).find(item => item.id === shotId) ?? (analysis === undefined ? undefined
    : assembleTimeline([source], [analysis]).shots.find(item => item.id === shotId))
  if (shot === undefined) return null
  const version = videoEditions(sources, source, shot.authoredNumber)?.current.number
  return <div className={css.dock}>
    <div className={css.scope} data-muse-composer-scope>
      <span className={css.caption}>{t('previewing')}</span>
      <span className={css.range}>{videoShotScopeLabel(shot, t, version)}</span>
    </div>
  </div>
}

/** Keep the selected shot visible above a draft even when its video panel is collapsed.
 * @param props - Conversation store, current inventory and locale bindings.
 * @returns Current available shot context without mutating the draft.
 */
export function VideoComposerScope(props: VideoComposerScopeProps) {
  const sourceId = props.useStore(state => state.selected)
  const shotId = props.useStore(state => state.selectedShot)
  return sourceId === null || shotId === null ? null : <SelectedShotScope {...props} sourceId={sourceId} shotId={shotId} />
}
