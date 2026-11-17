/** Current-account profile and relay observations from account-data-v1 services. */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MuseAccountRelayDetails as RelayDetails } from '@deepseek-ai/dsh-muse-account/types'
import type { MuseAccountSectionProps } from './MuseAccountSection.tsx'
import type { MuseAccountLocaleKey } from './locales.ts'
import css from './MuseAccountDetails.module.css'
import { MuseAccountProfileSections } from './MuseAccountProfileSections.tsx'
import { MuseAccountOrganization } from './MuseAccountOrganization.tsx'
import { MuseAccountHistory } from './MuseAccountHistory.tsx'

type RelayPeriod = 'today' | '7d' | '30d'
interface RelayDetailsProps extends Pick<MuseAccountSectionProps, 't'> {
  readonly value: RelayDetails
  readonly period: 'today' | '7d' | '30d' | 'all'
  readonly offset: number
  readonly busy: boolean
  readonly failed: boolean
  readonly onRefresh: () => void
  readonly onPeriod: (period: RelayPeriod) => void
  readonly onPrevious: (() => void) | undefined
  readonly onNext: (cursor: string) => void
}
const periods = ['today', '7d', '30d'] as const
const periodCopy = { today: 'periodToday', '7d': 'periodWeek', '30d': 'periodMonth' } as const
const metrics = [
  ['totalTokens', 'totalTokens'], ['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'],
  ['requests', 'requestCount'], ['completedRequests', 'completedRequests'], ['failedRequests', 'failedRequests'],
  ['pendingRequests', 'pendingRequests'], ['unknownRequests', 'unknownRequests'],
  ['reportedUsageRequests', 'reportedRequestCount'], ['partialUsageRequests', 'partialUsageRequests'],
  ['unreportedUsageRequests', 'unreportedUsageRequests'],
] as const satisfies ReadonlyArray<readonly [keyof RelayDetails['usage']['summary'], MuseAccountLocaleKey]>
const states = { completed: 'completedRequests', failed: 'failedRequests', pending: 'pendingRequests', unknown: 'unknownRequests' } as const
const reports = { reported: 'reportedUsage', partial: 'partialUsage', unreported: 'notReported' } as const
const errors = { request_rejected: 'requestRejected', upstream_http: 'upstreamHttpError',
  invalid_content_type: 'invalidContentType', transport: 'requestTransportError', cancelled: 'requestCancelled' } as const
const tokenColumns = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens'] as const

/**
 * Display the authenticated account's reported usage and the service's explicit information gaps.
 * @param props - Verified relay data, query controls and localized copy.
 * @returns Account availability and a cursor-paginated request table.
 */
export function MuseAccountRelayDetails({ t, value, period, offset, busy, failed,
  onRefresh, onPeriod, onPrevious, onNext }: RelayDetailsProps): ReactNode {
  const usage = value.usage
  const nextCursor = usage.nextCursor
  const number = (count: number | null | undefined): string => count === null || count === undefined ? t('notReported') : count.toLocaleString()
  return <div className={css.details} data-muse-account-details aria-busy={busy}>
    {value.history === undefined ? null : <MuseAccountHistory t={t} value={value.history} />}
    {value.profile === undefined ? <>
      <section className={css.card} aria-label={t('profileTitle')}>
        <h4 className={css.heading}>{t('profileTitle')}</h4>
        <dl className={css.profile}><div><dt>{t('accountId')}</dt><dd>{value.account.id}</dd></div></dl>
        <p className={css.note}>{t('profileNotProvided')}</p>
        {value.organization === undefined ? <>
          <h4 className={css.heading}>{t('feishuDepartments')}</h4>
          <p className={css.note}>{t('departmentsNotProvided')}</p>
        </> : <MuseAccountOrganization t={t} organization={value.organization} />}
      </section>
      <section className={css.card} aria-label={t('groupsTitle')}>
        <h4 className={css.heading}>{t('groupsTitle')}</h4>
        <p className={css.note}>{t('groupsNotProvided')}</p>
      </section>
    </> : <MuseAccountProfileSections t={t} account={value.profile.account}
      groups={value.profile.groups} organization={value.profile.organization} />}
    <section className={css.card} aria-label={t(value.history === undefined ? 'usageTitle' : 'relayDetailTitle')}>
      <div className={css.toolbar}>
        <h4 className={css.heading}>{t(value.history === undefined ? 'usageTitle' : 'relayDetailTitle')}</h4>
        <label className={css.period}>{t('usagePeriod')}
          <select value={period} disabled={busy} onChange={(event) => { onPeriod(event.currentTarget.value as RelayPeriod) }}>
            {periods.map(item => <option key={item} value={item}>{t(periodCopy[item])}</option>)}
          </select>
        </label>
        <Button disabled={busy} onClick={onRefresh}>{t('refreshUsage')}</Button>
      </div>
      {value.history === undefined ? null : <p className={css.note}>{t('historyOverlap')}</p>}
      <p className={css.note}>{t('relayUsageScope')}</p>
      <p className={css.note}>{t('relayUsagePeriod', { from: usage.from, to: usage.to })}</p>
      <dl className={css.metrics} data-muse-usage-summary>{metrics.map(([key, label]) => <div key={key}
        className={key === 'totalTokens' ? css.totalMetric : undefined}>
        <dt>{t(label)}</dt><dd>{number(usage.summary[key])}</dd>
      </div>)}</dl>
      <p className={css.note}>{t('usageMissing')}</p>
      {usage.health.state === 'degraded' ? <p className={css.note} role="status">{t('usageDegraded')}</p> : null}
      <h4 className={css.heading}>{t('usageRequests')}</h4>
      {usage.items.length === 0 ? <p className={css.note}>{t('noUsage')}</p> : <div className={css.scroll}>
        <table className={css.table} aria-label={t('usageRequests')}><thead><tr>
          <th>{t('requestId')}</th><th>{t('dateUtc')}</th><th>{t('model')}</th><th>{t('relayRoute')}</th>
          <th>{t('requestStatus')}</th><th>{t('usageReport')}</th><th>{t('usageSource')}</th>
          {tokenColumns.map(label => <th key={label}>{t(label)}</th>)}
        </tr></thead><tbody>{usage.items.map((row) => {
          const counts = row.usage
          const tokens = [
            ['inputTokens', counts?.input_tokens ?? counts?.prompt_tokens],
            ['outputTokens', counts?.output_tokens ?? counts?.completion_tokens], ['totalTokens', counts?.total_tokens],
            ['cachedInputTokens', counts?.prompt_cache_hit_tokens ?? counts?.input_tokens_details?.cached_tokens ?? counts?.prompt_tokens_details?.cached_tokens],
            ['reasoningTokens', counts?.reasoning_tokens ?? counts?.completion_tokens_details?.reasoning_tokens ?? counts?.output_tokens_details?.reasoning_tokens],
          ] as const
          const status = row.upstreamStatus ?? row.clientStatus
          return <tr key={row.requestId}>
            <td className={css.requestId}>{row.requestId}</td>
            <td>{new Date(row.startedAt).toISOString().replace('T', ' ').replace('Z', '')}</td>
            <td>{row.responseModel ?? row.forwardedModel ?? row.requestedModel ?? t('notReported')}</td>
            <td>{row.route ?? t('notReported')}</td>
            <td>{t(states[row.state])}{status === null ? null : <span className={css.detail}>{t('httpStatus', { status })}</span>}
              {row.errorKind === null ? null : <span className={css.detail}>{t(errors[row.errorKind])}</span>}</td>
            <td>{t(reports[row.usageStatus])}</td>
            <td>{t(row.channel === 'desktop-relay' ? 'sourceDesktopRelay' : 'sourceCloudRelay')}</td>
            {tokens.map(([key, count]) => <td key={key}>{number(count)}</td>)}
          </tr>
        })}</tbody></table>
      </div>}
      <div className={css.toolbar}>
        <Button disabled={busy || onPrevious === undefined} onClick={onPrevious}>{t('previousPage')}</Button>
        <p className={css.note}>{t('usagePage', { start: usage.items.length === 0 ? 0 : offset + 1,
          end: offset + usage.items.length, total: usage.summary.requests })}</p>
        <Button disabled={busy || nextCursor === null}
          onClick={nextCursor === null ? undefined : () => { onNext(nextCursor) }}>{t('nextPage')}</Button>
      </div>
      {failed ? <p className={css.note} role="status">{t('detailsUnavailable')}</p> : null}
    </section>
  </div>
}
