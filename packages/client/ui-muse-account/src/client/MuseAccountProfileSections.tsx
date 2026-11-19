/** Shared profile and informational memberships for both account usage protocols. */

import type { ReactNode } from 'react'
import type { MuseAccountFullDetails, MuseAccountProfile } from '@deepseek-ai/dsh-muse-account/types'
import type { MuseAccountSectionProps } from './MuseAccountSection.tsx'
import css from './MuseAccountDetails.module.css'
import { MuseAccountOrganization } from './MuseAccountOrganization.tsx'

interface ProfileSectionsProps extends Pick<MuseAccountSectionProps, 't'> {
  readonly account: MuseAccountFullDetails['account']
  readonly groups: MuseAccountFullDetails['groups']
  readonly organization?: MuseAccountProfile['organization']
}

function timestamp(value: string | null, unknown: string): string {
  return value === null ? unknown : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

/**
 * Display current-account profile fields and memberships separately from usage coverage.
 * @param props - Verified profile, assigned Muse groups, optional account-level directory membership, and copy.
 * @returns Profile and group sections without account actions or credentials.
 */
export function MuseAccountProfileSections({ t, account, groups, organization }: ProfileSectionsProps): ReactNode {
  const unknown = t('notReported')
  return <>
    <section className={css.card} aria-label={t('profileTitle')}>
      <h4 className={css.heading}>{t('profileTitle')}</h4>
      <dl className={css.profile}>
        <div><dt>{t('accountId')}</dt><dd>{account.id}</dd></div>
        <div><dt>{t('accountName')}</dt><dd>{account.username}</dd></div>
        <div><dt>{t('createdAt')}</dt><dd>{timestamp(account.createdAt, unknown)}</dd></div>
        <div><dt>{t('lastLoginAt')}</dt><dd>{timestamp(account.lastLoginAt, unknown)}</dd></div>
        <div><dt>{t('lastActivityAt')}</dt><dd>{timestamp(account.lastActivityAt, unknown)}</dd></div>
      </dl>
      <h4 className={css.heading}>{t('feishuIdentities')}</h4>
      {account.feishuIdentities.length === 0 ? <p className={css.note}>{t('noFeishuIdentity')}</p>
        : <ul className={css.list}>{account.feishuIdentities.map(identity => <li key={`${identity.name}:${identity.boundAt}`}>
          <span>{identity.name}</span>
          <span className={css.note}>{t('feishuOrganization', { organization: identity.tenantKey ?? unknown })}</span>
          <span className={css.note}>{t('feishuBoundAt', { date: timestamp(identity.boundAt, unknown) })}</span>
          <span className={css.note}>{t('feishuLastLogin', { date: timestamp(identity.lastLoginAt, unknown) })}</span>
          {organization !== undefined ? null : identity.organization === undefined
            ? <span className={css.note}>{t('feishuDepartmentsRelogin')}</span>
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
      {organization === undefined ? null : <MuseAccountOrganization t={t} organization={organization} />}
    </section>
    <section className={css.card} aria-label={t('groupsTitle')}>
      <h4 className={css.heading}>{t('groupsTitle')}</h4>
      <p className={css.note}>{t('groupsDescription')}</p>
      {groups.length === 0 ? <p className={css.note}>{t('noGroups')}</p>
        : <ul className={css.list}>{groups.map(group => <li key={group.id}>
          <span>{group.name}</span>
          {group.description ? <span className={css.note}>{group.description}</span> : null}
        </li>)}</ul>}
    </section>
  </>
}
