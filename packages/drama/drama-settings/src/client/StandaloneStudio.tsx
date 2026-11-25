/** Loopback-only embedded workbench, selected independently of the provider settings. */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { Button, IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DramaSettingsSectionProps } from './DramaSettingsSection.tsx'
import css from './StandaloneStudio.module.css'

const PANEL_ID = 'muse-standalone-studio' as MainPanelId
const READY_TIMEOUT_MS = 8_000

type Translate = DramaSettingsSectionProps['t']
type FrameState = 'loading' | 'ready' | 'unavailable'

function StudioIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconGlobeOutlineRegular size={size} />
}

function StudioFrame({ origin, t, retry }: { origin: string; t: Translate; retry: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [state, setState] = useState<FrameState>('loading')
  useEffect(() => {
    const timeout = setTimeout(() => { setState('unavailable') }, READY_TIMEOUT_MS)
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return
      const data = event.data
      if (typeof data !== 'object' || data === null || !('type' in data) || !('version' in data)
        || data.type !== 'muse-localminidrama:ready' || data.version !== 1) return
      clearTimeout(timeout)
      setState('ready')
    }
    window.addEventListener('message', receive)
    return () => {
      clearTimeout(timeout)
      window.removeEventListener('message', receive)
    }
  }, [origin])

  return <div className={css.stage}>
    <iframe
      className={css.frame}
      data-ready={state === 'ready' || undefined}
      ref={frame}
      src={origin}
      title={t('studioPanel')}
      sandbox="allow-scripts allow-same-origin allow-downloads allow-forms allow-modals"
      referrerPolicy="no-referrer"
      onLoad={() => { frame.current?.contentWindow?.postMessage({ type: 'muse-localminidrama:ping', version: 1 }, origin) }}
    />
    {state !== 'ready' && <div className={css.state}>
      <p role="status">{t(state === 'loading' ? 'studioLoading' : 'studioUnavailable')}</p>
      {state === 'unavailable' && <Button onClick={retry}>{t('studioRetry')}</Button>}
    </div>}
  </div>
}

function StandaloneStudio({ origin, t }: { origin: string; t: Translate }) {
  const [attempt, setAttempt] = useState(0)
  return <section className={css.panel} aria-label={t('studioPanel')}>
    <header className={css.header}><h1>{t('studioPanel')}</h1></header>
    <StudioFrame key={attempt} origin={origin} t={t} retry={() => { setAttempt(previous => previous + 1) }} />
  </section>
}

/**
 * Register the standalone panel only in a configured Muse desktop main document.
 * @param ctx - Client plugin scope with the shared slot registry.
 * @param t - Bound short-drama dictionary.
 */
export function registerStandaloneStudio(ctx: Context, t: Translate): void {
  const desktop = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly productName?: string; readonly standaloneStudioOrigin?: string }
  }).dshDesktop
  if (desktop?.productName !== 'muse-med' || desktop.standaloneStudioOrigin === undefined
    || globalThis.location.protocol !== 'dsh-app:' || globalThis.location.hostname !== 'app') return
  const origin = desktop.standaloneStudioOrigin
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: 'settings.drama', inject: () => ({ origin, t }),
  }, StandaloneStudio))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 15, locale: 'settings.drama', label: () => t('studioPanel'),
  }, StudioIcon))
}
