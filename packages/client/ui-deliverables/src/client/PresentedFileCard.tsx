import type { ContextMenuTriggerProps } from '@deepseek-ai/dsh-client-ui-context-menu/client'
/** File identity, Sidebar preview, and contributed native actions for one delivery. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { FileTypeIcon, fileExtension } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PresentedHost } from '../presented.ts'
import type { PresentedOpenPhase } from './present-open.ts'
import { basename, type PresentedPath } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './Deliverables.module.css'

function cardDescription(description: string | undefined, fallback: string): string {
  const trimmed = description?.replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/u, '').trim()
  return trimmed === undefined || trimmed === '' ? fallback : trimmed
}

/**
 * Native playback retained when no delivery-video extension is registered.
 * @param props - Session-authorized stream, file name and native localized copy.
 * @returns A player that releases its source on unmount.
 */
export function DeliveredVideo({ source, name, t }: { source: string; name: string } & PropsLocale<typeof NS>) {
  const [failed, setFailed] = useState(false)
  const player = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = player.current
    video?.setAttribute('src', source)
    return () => {
      if (video) { video.pause(); video.removeAttribute('src'); video.load() }
    }
  }, [source, failed])
  return <div className={css.videoBody}>
    {failed ? <p className={css.videoError} role="alert">{t('presented.videoError')}</p>
      : <video ref={player} className={css.videoPlayer} src={source} controls playsInline preload="metadata"
        tabIndex={0} aria-label={t('presented.videoPlayer', { name })} data-presented-video
        onError={() => { setFailed(true) }} />}
  </div>
}

/**
 * Render independent file actions without nesting buttons inside a clickable card.
 * @param props - durable file metadata, Sidebar preview, Host capabilities, gesture status, and localized copy.
 * @returns the file card and its anchored action menu.
 */
export function PresentedFileCard({ file, cwd, phase, host, onPreview, contextMenuProps, actions, videoSource, videoContent, t }: {
  file: PresentedPath
  cwd: string | undefined
  phase: PresentedOpenPhase | undefined
  host: PresentedHost | null
  onPreview: () => void
  contextMenuProps: ContextMenuTriggerProps
  actions: ReactNode
  videoSource?: string | undefined
  videoContent?: ReactNode
} & PropsLocale<typeof NS>) {
  const reveal = host?.fileManager ?? 'directory'
  const name = basename(file.path)
  const metadata = fileExtension(name).toUpperCase() || t('presented.file')
  const status = phase === undefined
    ? cardDescription(file.description, metadata)
    : t(reveal === 'directory' && phase === 'revealing' ? 'presented.directoryOpening'
      : reveal === 'directory' && phase === 'revealError' ? 'presented.directoryError' : `presented.${phase}`)
  return <div className={css.file} data-presented-file data-video={videoSource === undefined ? undefined : true}>
    <div className={css.fileHeader}>
      <button type="button" className={css.cardPreview} title={resolveWorkspacePath(cwd, file.path)}
        aria-label={t('presented.previewCard', { name: file.path })} onClick={onPreview} {...contextMenuProps} />
      <span className={css.fileIcon}><FileTypeIcon path={file.path} size={20} /></span>
      <div className={css.fileBody}>
        <div className={css.details}>
          <span className={css.fileName}>{name}</span>
          <span className={css.description} data-presented-description role={phase === undefined ? undefined : 'status'}
            data-error={phase === 'error' || phase === 'revealError' || phase === 'nativeUnavailable' ? true : undefined}>
            <span className={css.secondaryText}>
              {status}
            </span>
            <span className={css.previewHint}>{t('presented.preview')}</span>
          </span>
        </div>
        <div className={css.actions}>{actions}</div>
      </div>
    </div>
    {videoContent ?? (videoSource !== undefined && <DeliveredVideo key={videoSource} source={videoSource} name={name} t={t} />)}
  </div>
}
