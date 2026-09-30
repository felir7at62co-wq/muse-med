/** Native browser video controls over authenticated, bounded Host byte streams. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { hostFileOf, type SessionFile } from '../rpc.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import type {} from './locales.ts'
import css from './VideoBody.module.css'

/** Versioned source URL resolved through the addressed Session. */
export interface VideoSource {
  /** Same-origin authenticated video URL. */
  readonly url: string
  /** Source freshness observed before playback. */
  readonly version: string
}

/** Host metadata reader supplied by the renderer registration. */
export interface VideoBodyInjected {
  /**
   * Resolve the addressed file without transferring its full content.
   * @param file - Session and workspace path.
   * @param signal - Cancels metadata resolution.
   * @returns Versioned same-origin playback URL.
   */
  readonly resolveSource: (file: SessionFile, signal: AbortSignal) => Promise<VideoSource>
}

/** Standard document owner and typed video renderer inputs. */
export type VideoBodyProps = DocumentPreviewProps & PropsLocale<'sidebarVideo'> & InjectFace<VideoBodyInjected>

/**
 * Render native playback without buffering complete files in the Client.
 * @param props - Renderer-owned load, addressed file, metadata callback and locale.
 * @returns Accessible video controls or the current load failure.
 */
export function VideoBody(props: VideoBodyProps): ReactNode {
  const { content, resourceAddress, resolveSource, t } = props
  const { tab } = props.useTabInfo()
  const revision = content.kind === 'renderer' ? content.revision : undefined
  const [state, setState] = useState<{ revision: number; source?: VideoSource; failed?: boolean }>()
  const player = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (content.kind !== 'renderer') return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, tab.signal])
    void resolveSource(hostFileOf(resourceAddress), signal).then((source) => {
      if (!signal.aborted) setState({ revision: content.revision, source })
    }, () => {
      if (!signal.aborted) { setState({ revision: content.revision, failed: true }); content.failed() }
    })
    return () => { controller.abort() }
  }, [revision, resourceAddress, resolveSource, tab.signal])
  useEffect(() => {
    const video = player.current
    return () => {
      if (video) { video.pause(); video.removeAttribute('src'); video.load() }
    }
  }, [state?.source?.url, revision])
  if (revision === undefined) return null
  if (state?.revision !== revision) return <LoadingIndicator label={t('loading')} />
  if (state.failed || !state.source) return <p className={css.status} role="alert">{t('failed')}</p>
  const source = state.source
  return <div className={css.body} ref={props.scrollportRef}>
    <video ref={player} key={`${source.url}:${revision}`} className={css.player} src={source.url}
      controls playsInline preload="metadata" aria-label={t('player')} data-video-preview
      onLoadedMetadata={() => { if (content.kind === 'renderer') content.loaded(source.version) }}
      onError={() => {
        setState({ revision, failed: true })
        if (content.kind === 'renderer') content.failed()
      }} />
  </div>
}
