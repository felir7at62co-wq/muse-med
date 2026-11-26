/** Account-level directory membership shared by profile and relay-only account views. */

import type { ReactNode } from 'react'
import type { MuseAccountProfile } from '@deepseek-ai/dsh-muse-account/types'
import type { MuseAccountSectionProps } from './MuseAccountSection.tsx'
import css from './MuseAccountDetails.module.css'

interface OrganizationProps extends Pick<MuseAccountSectionProps, 't'> {
  readonly organization: MuseAccountProfile['organization']
}

/**
 * Display verified account-level department paths independently of profile availability.
 * @param props - Current account's department synchronization result and localized copy.
 * @returns Department membership and its known synchronization time.
 */
export function MuseAccountOrganization({ t, organization }: OrganizationProps): ReactNode {
  return <>
    <h4 className={css.heading}>{t('feishuDepartments')}</h4>
    {organization.updatedAt === null ? null : <p className={css.note}>{t('feishuDepartmentsUpdated', {
      date: new Date(organization.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    })}</p>}
    {organization.status === 'unavailable' ? <p className={css.note}>{t('feishuDepartmentsPending')}</p>
      : organization.departments.length === 0 ? <p className={css.note}>{t('feishuDepartmentsEmpty')}</p>
        : <ul className={css.list} aria-label={t('feishuDepartments')}>
          {organization.departments.map(department => <li key={department.id}>{department.path || department.name}</li>)}
        </ul>}
  </>
}
