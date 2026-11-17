/** Historical account usage independent of the current request-detail range. */

import type { ReactNode } from 'react'
import type { MuseAccountRelayHistory } from '@deepseek-ai/dsh-muse-account/types'
import type { MuseAccountSectionProps } from './MuseAccountSection.tsx'
import type { MuseAccountLocaleKey } from './locales.ts'
import css from './MuseAccountDetails.module.css'

interface HistoryProps extends Pick<MuseAccountSectionProps, 't'> {
  readonly value: MuseAccountRelayHistory
}
const tokenMetrics = [
  ['totalTokens', 'totalTokens', 'totalTokensReports'],
  ['inputTokens', 'inputTokens', 'inputTokensReports'],
  ['outputTokens', 'outputTokens', 'outputTokensReports'],
] as const
const requestMetrics = [
  ['requests', 'requestCount'], ['reported', 'historyReportedRequests'],
  ['partial', 'historyPartialRequests'], ['unknown', 'historyUnknownRequests'],
] as const satisfies ReadonlyArray<readonly [keyof MuseAccountRelayHistory['summary'], MuseAccountLocaleKey]>

/**
 * Display recorded historical totals with their period, report coverage and completeness.
 * @param props - Verified historical measurements and localized copy.
 * @returns Historical totals separate from overlapping request-detail measurements.
 */
export function MuseAccountHistory({ t, value }: HistoryProps): ReactNode {
  const summary = value.summary
  const number = (count: number | null): string => count === null ? t('notReported') : count.toLocaleString()
  const since = value.recordingSince === null ? t('notReported')
    : new Date(value.recordingSince).toLocaleString('zh-CN', { timeZone: value.timeZone, hour12: false })
  return <section className={css.card} aria-label={t('historyTitle')} data-muse-account-history>
    <h4 className={css.heading}>{t('historyTitle')}</h4>
    <dl className={`${css.metrics} ${css.historyMetrics}`} data-muse-history-summary>
      {tokenMetrics.map(([key, label, reports]) => <div key={key} className={key === 'totalTokens' ? css.totalMetric : undefined}>
        <dt>{t(label)}</dt><dd>{number(summary[key])}<span className={css.metricCoverage}>{t('historyFieldReports', {
          reports: number(summary[reports]), requests: number(summary.requests),
        })}</span></dd>
      </div>)}
      {requestMetrics.map(([key, label]) => <div key={key}><dt>{t(label)}</dt><dd>{number(summary[key])}</dd></div>)}
    </dl>
    <p className={css.note}>{t('historyScope')}</p>
    <p className={css.note}>{t('historyPeriod', { from: value.from, to: value.to })}</p>
    <p className={css.note}>{t('historyRecordingSince', { date: since })}</p>
    {value.limited ? <p className={css.note} role="status">{t('historyLimited')}</p> : null}
    {value.health.state === 'degraded' ? <p className={css.note} role="status">{t('historyDegraded')}</p> : null}
  </section>
}
