/** Current-account profile, group membership and paginated model usage. */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MuseAccountDetails as AccountDetails, MuseAccountDetailsRequest } from '@deepseek-ai/dsh-muse-account/types'
import type { MuseAccountInjected, MuseAccountSectionProps } from './MuseAccountSection.tsx'
import type { MuseAccountLocaleKey } from './locales.ts'
import css from './MuseAccountDetails.module.css'

type Period = NonNullable<MuseAccountDetailsRequest['period']>
type DetailsProps = Pick<MuseAccountSectionProps, 't'> & Pick<MuseAccountInjected, 'details'> & {
  readonly onInvalidSession: () => void
}
const periods: readonly Period[] = ['today', '7d', '30d', 'all']
const periodCopy: Record<Period, MuseAccountLocaleKey> = {
  today: 'periodToday', '7d': 'periodWeek', '30d': 'periodMonth', all: 'periodAll',
}
const tokenMetrics = [
  ['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'], ['totalTokens', 'totalTokens'],
  ['cachedInputTokens', 'cachedInputTokens'], ['reasoningTokens', 'reasoningTokens'],
] as const satisfies ReadonlyArray<readonly [keyof AccountDetails['usage']['summary'], MuseAccountLocaleKey]>
const metrics = [
  ['requests', 'requestCount'], ['reportedRequests', 'reportedRequestCount'], ...tokenMetrics,
] as const satisfies ReadonlyArray<readonly [keyof AccountDetails['usage']['summary'], MuseAccountLocaleKey]>

function timestamp(value: string | null, unknown: string): string {
  return value === null ? unknown : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

/**
 * Read only the verified account's details and discard responses after the account page closes.
 * @param props - Authenticated read action, localized copy and invalid-session handling.
 * @returns Profile and usage sections with independent query recovery.
 */
export function MuseAccountDetails({ t, details, onInvalidSession }: DetailsProps): ReactNode {
  const [query, setQuery] = useState<{ period: Period; offset: number; revision: number }>({ period: '30d', offset: 0, revision: 0 })
  const [result, setResult] = useState<{ value: AccountDetails; period: Period }>()
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let closed = false
    setBusy(true)
    setFailed(false)
    void details({ period: query.period, offset: query.offset, limit: 50 }).then((outcome) => {
      if (closed) return
      if (outcome.ok) setResult({ value: outcome.value, period: query.period })
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
  const usage = value.usage
  return <div className={css.details} data-muse-account-details aria-busy={busy}>
    <section className={css.card} aria-label={t('profileTitle')}>
      <h4 className={css.heading}>{t('profileTitle')}</h4>
      <dl className={css.profile}>
        <div><dt>{t('accountId')}</dt><dd>{value.account.id}</dd></div>
        <div><dt>{t('createdAt')}</dt><dd>{timestamp(value.account.createdAt, unknown)}</dd></div>
        <div><dt>{t('lastLoginAt')}</dt><dd>{timestamp(value.account.lastLoginAt, unknown)}</dd></div>
        <div><dt>{t('lastActivityAt')}</dt><dd>{timestamp(value.account.lastActivityAt, unknown)}</dd></div>
      </dl>
      <h4 className={css.heading}>{t('feishuIdentities')}</h4>
      {value.account.feishuIdentities.length === 0 ? <p className={css.note}>{t('noFeishuIdentity')}</p>
        : <ul className={css.list}>{value.account.feishuIdentities.map(identity => <li key={`${identity.name}:${identity.boundAt}`}>
          <span>{identity.name}</span>
          <span className={css.note}>{t('feishuOrganization', { organization: identity.tenantKey ?? t('notReported') })}</span>
          <span className={css.note}>{t('feishuBoundAt', { date: timestamp(identity.boundAt, unknown) })}</span>
          <span className={css.note}>{t('feishuLastLogin', { date: timestamp(identity.lastLoginAt, unknown) })}</span>
          {identity.organization === undefined ? <span className={css.note}>{t('feishuDepartmentsRelogin')}</span>
            : <>
              <span className={css.note}>{t('feishuDepartmentsUpdated', { date: timestamp(identity.organization.syncedAt, unknown) })}</span>
              {identity.organization.status === 'permission-required' ? <span className={css.note}>{t('feishuDepartmentsPermission')}</span>
                : identity.organization.status === 'unavailable' ? <span className={css.note}>{t('feishuDepartmentsUnavailable')}</span>
                  : identity.organization.departments.length === 0 ? <span className={css.note}>{t('feishuDepartmentsEmpty')}</span>
                    : <ul className={css.list} aria-label={t('feishuDepartments')}>
                      {identity.organization.departments.map(department => <li key={department.id}>
                        {department.path || department.name}
                      </li>)}
                    </ul>}
            </>}
        </li>)}</ul>}
    </section>
    <section className={css.card} aria-label={t('groupsTitle')}>
      <h4 className={css.heading}>{t('groupsTitle')}</h4>
      <p className={css.note}>{t('groupsDescription')}</p>
      {value.groups.length === 0 ? <p className={css.note}>{t('noGroups')}</p>
        : <ul className={css.list}>{value.groups.map(group => <li key={group.id}>
          <span>{group.name}</span>
          {group.description ? <span className={css.note}>{group.description}</span> : null}
        </li>)}</ul>}
    </section>
    <section className={css.card} aria-label={t('usageTitle')}>
      <div className={css.toolbar}>
        <h4 className={css.heading}>{t('usageTitle')}</h4>
        <label className={css.period}>{t('usagePeriod')}
          <select value={query.period} disabled={busy} onChange={(event) => {
            const period = event.currentTarget.value as Period
            setQuery(current => ({ period, offset: 0, revision: current.revision + 1 }))
          }}>{periods.map(period => <option key={period} value={period}>{t(periodCopy[period])}</option>)}</select>
        </label>
        <Button disabled={busy} onClick={reload}>{t('refreshUsage')}</Button>
      </div>
      <p className={css.note}>{t('usageScope')}</p>
      <p className={css.note}>{t('usageTrackingSince', { date: timestamp(usage.since, unknown) })}</p>
      <p className={css.note}>{t('usageUpdatedAt', { date: timestamp(usage.updatedAt, unknown) })}</p>
      <p className={css.note}>{t('usageDisplayedPeriod', { period: t(periodCopy[result.period]) })}</p>
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
          <td className={css.requestId}>{row.id}</td><td>{timestamp(row.at, unknown)}</td><td>{row.provider}</td><td>{row.model}</td><td>{row.status === null ? unknown : t('httpStatus', { status: row.status })}</td>
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
