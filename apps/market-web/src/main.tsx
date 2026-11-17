/** Standalone website over the shared Muse market presentation and same-origin account. */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, IconWarningOutlineRegular, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { MarketBrowserPage } from '@deepseek-ai/dsh-client-ui-muse-market/src/client/browser.tsx'
import type { MarketBrowserView } from '@deepseek-ai/dsh-client-ui-muse-market/src/client/market-browser-actions.ts'
import { marketZh } from '@deepseek-ai/dsh-client-ui-muse-market/src/client/market-locales.ts'
import type { MarketOutcomeKey, MarketTranslate } from '@deepseek-ai/dsh-client-ui-muse-market/src/client/market-actions.ts'
import { createMarketBrowserClient, marketWebConfig, readMarketBody, type MarketBrowserClient } from './api.ts'
import { webZh } from './web-locales.ts'
import '../../../packages/client/ui-theme/src/styles/base.css'
import '../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../packages/client/ui-theme/src/styles/scrollbar.css'
import '../../../packages/client/ui-theme/src/styles/focus.css'
import './market-web.css'

const t: MarketTranslate = (key, args) => {
  let value: string = marketZh[key]
  for (const [name, replacement] of Object.entries(args ?? {})) value = value.replaceAll('{' + name + '}', String(replacement))
  return value
}
const locationView = (): MarketBrowserView => window.location.pathname === '/market/manage'
  ? new URLSearchParams(window.location.search).get('view') === 'upload' ? 'upload' : 'publish' : 'discover'

function Website() {
  const [view, setView] = useState(locationView)
  const [client, setClient] = useState<MarketBrowserClient>()
  const [failed, setFailed] = useState(false)
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [outcome, setOutcome] = useState<{ key: MarketOutcomeKey; failed: boolean; sequence: number }>()
  useEffect(() => { document.body.toggleAttribute('data-ds-dark-theme', dark) }, [dark])
  useEffect(() => {
    const pop = () => { setView(locationView()) }
    window.addEventListener('popstate', pop)
    return () => { window.removeEventListener('popstate', pop) }
  }, [])
  useEffect(() => {
    const controller = new AbortController(); let active: MarketBrowserClient | undefined
    void (async () => {
      try {
        const response = await fetch('/market/ui/config.json', { credentials: 'same-origin', mode: 'same-origin',
          cache: 'no-store', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
        if (!response.ok) { await response.body?.cancel(); throw Error('invalid-market-config') }
        const body = new TextDecoder('utf-8', { fatal: true }).decode(await readMarketBody(response, 16384))
        const input: unknown = JSON.parse(body)
        active = createMarketBrowserClient(marketWebConfig(input))
        if (controller.signal.aborted) await active.close()
        else setClient(active)
      } catch (_error) { if (!controller.signal.aborted) setFailed(true) }
    })()
    return () => { controller.abort(); void active?.close() }
  }, [])
  const navigate = (next: MarketBrowserView): void => {
    const path = next === 'discover' ? '/market/' : next === 'upload' ? '/market/manage?view=upload' : '/market/manage'
    window.history.pushState(null, '', path); setView(next)
  }
  const reportOutcome = (key: MarketOutcomeKey, isFailure: boolean): void => {
    setOutcome(previous => ({ key, failed: isFailure, sequence: (previous?.sequence ?? 0) + 1 }))
  }
  return <div className="market-web-shell">
    <div className="market-web-tools"><a href="/workbench">{webZh.workbench}</a>
      <Button size="sm" variant="ghost" onClick={() => { setDark(value => !value) }}>{dark ? webZh.light : webZh.dark}</Button></div>
    {client ? <MarketBrowserPage actions={client.actions} view={view} onNavigate={navigate} t={t} reportOutcome={reportOutcome} />
      : <div className="market-web-error">{failed ? <><p role="alert">{webZh.unavailable}</p>
        <Button onClick={() => { window.location.reload() }}>{webZh.retry}</Button></> : <div role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>}</div>}
    {outcome && (outcome.failed
      ? <Toast key={outcome.sequence} text={t(outcome.key)} icon={<IconWarningOutlineRegular />} onDone={() => { setOutcome(undefined) }} />
      : <Toast key={outcome.sequence} text={t(outcome.key)} tone="success" onDone={() => { setOutcome(undefined) }} />)}
  </div>
}

document.title = t('nav')
const element = document.getElementById('root')
if (!element) throw Error('Missing market root element')
createRoot(element).render(<Website />)
