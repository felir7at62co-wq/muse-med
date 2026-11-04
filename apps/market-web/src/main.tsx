/** Standalone market website using the shared Muse market page and same-origin account session. */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { Button, IconWarningOutlineRegular, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { MarketPage } from '@deepseek-ai/dsh-client-ui-muse-account/src/client/MarketPage.tsx'
import type { MarketSectionProps } from '@deepseek-ai/dsh-client-ui-muse-account/src/client/MarketSection.tsx'
import { marketZh, type MarketLocaleKey } from '@deepseek-ai/dsh-client-ui-muse-account/src/client/market-locales.ts'
import { createMarketBrowserClient, marketWebConfig, readMarketBody, type MarketBrowserClient } from './api.ts'
import '../../../packages/client/ui-theme/src/styles/base.css'
import '../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../packages/client/ui-theme/src/styles/gradient-shadow-text.css'
import '../../../packages/client/ui-theme/src/styles/corner-shape.css'
import '../../../packages/client/ui-theme/src/styles/scrollbar.css'
import '../../../packages/client/ui-theme/src/styles/focus.css'
import './market-web.css'

const dictionary = { ...commonZh, ...marketZh }
const t: MarketSectionProps['t'] = (key, args) => {
  let copy: string = dictionary[key]
  for (const [name, value] of Object.entries(args ?? {})) copy = copy.replaceAll('{' + name + '}', String(value))
  return copy
}

function Website() {
  const [client, setClient] = useState<MarketBrowserClient>()
  const [failed, setFailed] = useState(false)
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [outcome, setOutcome] = useState<{ key: MarketLocaleKey; failed: boolean; sequence: number }>()
  useEffect(() => { document.body.toggleAttribute('data-ds-dark-theme', dark) }, [dark])
  useEffect(() => {
    const controller = new AbortController(); let active: MarketBrowserClient | undefined
    void (async () => {
      try {
        const response = await fetch('/market/ui/config.json', { credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
        if (!response.ok) { await response.body?.cancel(); throw Error('invalid-market-config') }
        const body = new TextDecoder('utf-8', { fatal: true }).decode(await readMarketBody(response, 16384))
        const value: unknown = JSON.parse(body)
        active = createMarketBrowserClient(marketWebConfig(value))
        if (controller.signal.aborted) await active.close()
        else setClient(active)
      } catch (_error) {
        if (!controller.signal.aborted) setFailed(true)
      }
    })()
    return () => { controller.abort(); void active?.close() }
  }, [])
  return <div className="market-web-shell">
    <div className="market-web-tools"><a href="/workbench">{t('browserWorkbench')}</a>
      <Button size="sm" variant="ghost" onClick={() => { setDark(value => !value) }}>{t(dark ? 'lightTheme' : 'darkTheme')}</Button></div>
    {client ? <MarketPage mode="web" actions={client.actions} initialView={window.location.pathname.endsWith('/manage') ? 'publish' : 'discover'} t={t}
      reportOutcome={(key, isFailure) => {
        setOutcome(previous => ({ key, failed: isFailure, sequence: (previous?.sequence ?? 0) + 1 }))
      }} />
      : <div className="market-web-error">{failed ? <><p role="alert">{t('error.market-unavailable')}</p>
        <Button onClick={() => { window.location.reload() }}>{t('retry')}</Button></> : <div role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>}</div>}
    {outcome && (outcome.failed
      ? <Toast key={outcome.sequence} text={t(outcome.key)} icon={<IconWarningOutlineRegular />} onDone={() => { setOutcome(undefined) }} />
      : <Toast key={outcome.sequence} text={t(outcome.key)} tone="success" onDone={() => { setOutcome(undefined) }} />)}
  </div>
}

document.title = t('nav')
const element = document.getElementById('root')
if (!element) throw Error('Missing market root element')
createRoot(element).render(<Website />)
