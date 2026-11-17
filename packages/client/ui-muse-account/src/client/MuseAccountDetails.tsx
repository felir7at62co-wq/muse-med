/** Current-account profile, group membership and paginated model usage. */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MuseAccountDetails as AccountDetails, MuseAccountFullDetails, MuseAccountDetailsRequest } from '@deepseek-ai/dsh-muse-account/types'
import type { MuseAccountInjected, MuseAccountSectionProps } from './MuseAccountSection.tsx'
import type { MuseAccountLocaleKey } from './locales.ts'
import css from './MuseAccountDetails.module.css'
import { MuseAccountRelayDetails } from './MuseAccountRelayDetails.tsx'
import { MuseAccountProfileSections } from './MuseAccountProfileSections.tsx'

type Period = NonNullable<MuseAccountDetailsRequest['period']>
type DetailsProps = Pick<MuseAccountSectionProps, 't'> & Pick<MuseAccountInjected, 'details'> & {
  readonly onInvalidSession: () => void
}
interface DetailsQuery {
  readonly period: Period
  readonly offset: number
  readonly revision: number
  readonly cursor: string | undefined
  readonly range: MuseAccountDetailsRequest['range']
  readonly previous: readonly { readonly cursor: string | undefined; readonly offset: number }[]
}
const periods: readonly Period[] = ['today', '7d', '30d', 'all']
const periodCopy: Record<Period, MuseAccountLocaleKey> = {
  today: 'periodToday', '7d': 'periodWeek', '30d': 'periodMonth', all: 'periodAll',
}
const tokenMetrics = [
  ['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'], ['totalTokens', 'totalTokens'],
  ['cachedInputTokens', 'cachedInputTokens'], ['reasoningTokens', 'reasoningTokens'],
] as const satisfies ReadonlyArray<readonly [keyof MuseAccountFullDetails['usage']['summary'], MuseAccountLocaleKey]>
const metrics = [
  ['requests', 'requestCount'], ['reportedRequests', 'reportedRequestCount'], ...tokenMetrics,
] as const satisfies ReadonlyArray<readonly [keyof MuseAccountFullDetails['usage']['summary'], MuseAccountLocaleKey]>

function timestamp(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

/**
 * Read only the verified account's details and discard responses after the account page closes.
 * @param props - Authenticated read action, localized copy and invalid-session handling.
 * @returns Profile and usage sections with independent query recovery.
 */
export function MuseAccountDetails({ t, details, onInvalidSession }: DetailsProps): ReactNode {
  const [query, setQuery] = useState<DetailsQuery>({ period: '30d', offset: 0, revision: 0,
    cursor: undefined, range: undefined, previous: [] })
  const [result, setResult] = useState<{ value: AccountDetails; query: DetailsQuery }>()
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let closed = false
    setBusy(true)
    setFailed(false)
    void details({ period: query.period, offset: query.offset, limit: 50,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.range === undefined ? {} : { range: query.range }) }).then((outcome) => {
      if (closed) return
      if (outcome.ok) setResult({ value: outcome.value, query })
      else if (outcome.code === 'muse-account/invalid-credentials') onInvalidSession()
      else setFailed(true)
    }).catch(() => { if (!closed) setFailed(true) }).finally(() => { if (!closed) setBusy(false) })
    return () => { closed = true }
  }, [details, query, onInvalidSession])

  const reload = (): void => { setQuery(current => ({ ...current, revision: current.revision + 1 })) }
  const unknown = t('notReported')
  const number = (value: number | null): string => value === null ? unknown : value.toLocaleString()
  if (result === undefined) return <div className={css.details} data-muse-account-details aria-busy={busy}>
    <div className={css.initial}>
      {busy ? <StateDot state="ongoing" /> : null}
      {failed ? <p className={css.note} role="status">{t('detailsUnavailable')}</p> : null}
      {failed ? <Button disabled={busy} onClick={reload}>{t('retry')}</Button> : null}
    </div>
  </div>
  const value = result.value
  const previousPage = result.query.previous.at(-1)
  if (value.protocol === 'account-data-v1') return <MuseAccountRelayDetails t={t} value={value}
    period={query.period} offset={result.query.offset} busy={busy} failed={failed}
    onRefresh={() => {
      setQuery(current => ({ ...current, offset: 0, revision: current.revision + 1,
        cursor: undefined, range: undefined, previous: [] }))
    }} onPeriod={(period) => {
      setQuery(current => ({ period, offset: 0, revision: current.revision + 1,
        cursor: undefined, range: undefined, previous: [] }))
    }} onPrevious={previousPage === undefined ? undefined : () => {
      setQuery(current => ({ ...result.query, ...previousPage, revision: current.revision + 1,
        range: { from: value.usage.from, to: value.usage.to },
        previous: result.query.previous.slice(0, -1) }))
    }} onNext={(nextCursor) => {
      setQuery(current => ({ ...result.query, revision: current.revision + 1, cursor: nextCursor,
        range: { from: value.usage.from, to: value.usage.to },
        offset: result.query.offset + value.usage.items.length,
        previous: [...result.query.previous, { cursor: result.query.cursor, offset: result.query.offset }] }))
    }} />
  const usage = value.usage
  return <div className={css.details} data-muse-account-details aria-busy={busy}>
    <MuseAccountProfileSections t={t} account={value.account} groups={value.groups} />
    <section className={css.card} aria-label={t('usageTitle')}>
      <div className={css.toolbar}>
        <h4 className={css.heading}>{t('usageTitle')}</h4>
        <label className={css.period}>{t('usagePeriod')}
          <select value={query.period} disabled={busy} onChange={(event) => {
            const period = event.currentTarget.value as Period
            setQuery(current => ({ period, offset: 0, revision: current.revision + 1,
              cursor: undefined, range: undefined, previous: [] }))
          }}>{periods.map(period => <option key={period} value={period}>{t(periodCopy[period])}</option>)}</select>
        </label>
        <Button disabled={busy} onClick={reload}>{t('refreshUsage')}</Button>
      </div>
      <p className={css.note}>{t('usageScope')}</p>
      <p className={css.note}>{t('usageTrackingSince', { date: timestamp(usage.since) })}</p>
      <p className={css.note}>{t('usageUpdatedAt', { date: timestamp(usage.updatedAt) })}</p>
      <p className={css.note}>{t('usageDisplayedPeriod', { period: t(periodCopy[result.query.period]) })}</p>
      <dl className={css.metrics} data-muse-usage-summary>{metrics.map(([key, label]) => <div key={key}>
        <dt>{t(label)}</dt><dd>{number(usage.summary[key])}</dd>
      </div>)}</dl>
      <p className={css.note}>{t('usageMissing')}</p>
      <h4 className={css.heading}>{t('usageByModel')}</h4>
      {usage.byModel.length === 0 ? <p className={css.note}>{t('noUsage')}</p> : <div className={css.scroll}>
        <table className={css.table} aria-label={t('usageByModel')}><thead><tr>
          <th>{t('provider')}</th><th>{t('model')}</th>{metrics.map(([key, label]) => <th key={key}>{t(label)}</th>)}
        </tr></thead><tbody>{usage.byModel.map(row => <tr key={`${row.provider}:${row.model}`}>
          <td>{row.provider}</td><td>{row.model}</td>{metrics.map(([key]) => <td key={key}>{number(row[key])}</td>)}
        </tr>)}</tbody></table>
      </div>}
      <h4 className={css.heading}>{t('usageByDay')}</h4>
      {usage.byDay.length === 0 ? <p className={css.note}>{t('noUsage')}</p> : <div className={css.scroll}>
        <table className={css.table} aria-label={t('usageByDay')}><thead><tr>
          <th>{t('date')}</th>{metrics.map(([key, label]) => <th key={key}>{t(label)}</th>)}
        </tr></thead><tbody>{usage.byDay.map(row => <tr key={row.date}>
          <td>{row.date}</td>{metrics.map(([key]) => <td key={key}>{number(row[key])}</td>)}
        </tr>)}</tbody></table>
      </div>}
      <h4 className={css.heading}>{t('usageRequests')}</h4>
      {usage.recent.length === 0 ? <p className={css.note}>{t('noUsage')}</p> : <div className={css.scroll}>
        <table className={css.table} aria-label={t('usageRequests')}><thead><tr>
          <th>{t('requestId')}</th><th>{t('date')}</th><th>{t('provider')}</th><th>{t('model')}</th><th>{t('requestStatus')}</th><th>{t('usageSource')}</th>
          {tokenMetrics.map(([key, label]) => <th key={key}>{t(label)}</th>)}
        </tr></thead><tbody>{usage.recent.map(row => <tr key={row.id}>
          <td className={css.requestId}>{row.id}</td><td>{timestamp(row.at)}</td><td>{row.provider}</td><td>{row.model}</td><td>{row.status === null ? unknown : t('httpStatus', { status: row.status })}</td>
          <td>{t(row.source === 'desktop-direct' ? 'sourceDesktop' : 'sourceGateway')}</td>
          {tokenMetrics.map(([key]) => <td key={key}>{number(row[key])}</td>)}
        </tr>)}</tbody></table>
      </div>}
      <div className={css.toolbar}>
        <Button disabled={busy || usage.pagination.offset === 0} onClick={() => {
          setQuery(current => ({ ...current, offset: Math.max(0, usage.pagination.offset - usage.pagination.limit) }))
        }}>{t('previousPage')}</Button>
        <p className={css.note}>{t('usagePage', { start: usage.pagination.total === 0 ? 0 : usage.pagination.offset + 1,
          end: usage.pagination.offset + usage.recent.length, total: usage.pagination.total })}</p>
        <Button disabled={busy || !usage.pagination.hasMore} onClick={() => {
          setQuery(current => ({ ...current, offset: usage.pagination.offset + usage.pagination.limit }))
        }}>{t('nextPage')}</Button>
      </div>
      {failed ? <p className={css.note} role="status">{t('detailsUnavailable')}</p> : null}
    </section>
  </div>
}
