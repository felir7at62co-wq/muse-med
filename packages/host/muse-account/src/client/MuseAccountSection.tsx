/** MUSE account settings page. The Host returns identity and verification state without secrets. */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MuseAccountLoginRequest, MuseAccountLoginResult, MuseAccountStatus, MuseAccountStatusRequest } from '../types.ts'
import type { MuseAccountLocaleKey } from './locales.ts'
import css from './MuseAccountSection.module.css'

/** Successful Host value or a bounded Remote failure code. */
export type MuseAccountOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string }

/** Calls injected by the Settings registration; no password is passed to the agent. */
export interface MuseAccountInjected {
  /** Read the stored identity or verify its cookie with the gateway. */
  status: (request: MuseAccountStatusRequest) => Promise<MuseAccountOutcome<MuseAccountStatus>>
  /** Submit user-entered credentials directly to the Host. */
  login: (request: MuseAccountLoginRequest) => Promise<MuseAccountOutcome<MuseAccountLoginResult>>
  /** Remove the saved session cookie. */
  logout: () => Promise<MuseAccountOutcome<MuseAccountStatus>>
}

/** Full props assembled by the Settings slot renderer. */
export type MuseAccountSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.museAccount'>
  & InjectFace<MuseAccountInjected>

const ERROR_COPY: Record<string, MuseAccountLocaleKey> = {
  'muse-account/invalid-input': 'error.invalidInput',
  'muse-account/invalid-credentials': 'error.invalidCredentials',
  'muse-account/rate-limited': 'error.rateLimited',
  'muse-account/registration-disabled': 'error.registrationDisabled',
  'muse-account/gateway-unavailable': 'error.gatewayUnavailable',
  'muse-account/gateway-rejected': 'error.gatewayRejected',
  'muse-account/storage-failed': 'error.storageFailed',
}

/**
 * Render the account page.
 * @param props - composed Settings slot props.
 * @returns the page element tree.
 */
export function MuseAccountSection(props: MuseAccountSectionProps): ReactNode {
  const { t, status, login, logout } = props
  const [account, setAccount] = useState<MuseAccountStatus | undefined>(undefined)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [registerIfMissing, setRegisterIfMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<MuseAccountLocaleKey | undefined>(undefined)

  useEffect(() => {
    let current = true
    void status({ verify: false }).then((result) => {
      if (!current) return
      if (result.ok) setAccount(result.value)
      else setNotice(ERROR_COPY[result.code] ?? 'error.generic')
    }).catch(() => { if (current) setNotice('error.generic') })
    return () => { current = false }
  }, [status])

  const readStatus = async (verify: boolean): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await status({ verify })
      if (result.ok) setAccount(result.value)
      else setNotice(ERROR_COPY[result.code] ?? 'error.generic')
    } catch {
      setNotice('error.generic')
    } finally {
      setBusy(false)
    }
  }

  const signIn = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || username.trim().length === 0 || password.length === 0) return
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await login({ username: username.trim(), password, registerIfMissing })
      if (result.ok) {
        setAccount(result.value.status)
        setRegisterIfMissing(false)
        setNotice(result.value.outcome === 'registered' ? 'registered' : 'signedIn')
      } else {
        setNotice(ERROR_COPY[result.code] ?? 'error.generic')
      }
    } catch {
      setNotice('error.generic')
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await logout()
      if (result.ok) {
        setAccount(result.value)
        setUsername('')
        setNotice('signedOut')
      } else {
        setNotice(ERROR_COPY[result.code] ?? 'error.generic')
      }
    } catch {
      setNotice('error.generic')
    } finally {
      setPassword('')
      setBusy(false)
    }
  }

  return (
    <div className={css.section}>
      <h3 className={css.title}>{t('title')}</h3>
      <p className={css.description}>{t('description')}</p>
      {account === undefined
        ? <div className={css.actions}>
          {notice === undefined ? <p className={css.status} aria-busy="true">{t('loading')}</p> : null}
          {notice === undefined ? null : <Button disabled={busy} onClick={() => { void readStatus(false) }}>{t('retry')}</Button>}
        </div>
        : account.state === 'signed-in'
          ? <div className={css.group}>
            <p className={css.status}>{t('accountNamed', { username: account.username })}</p>
            <p className={css.status}>{t(account.verified ? 'verified' : 'verificationPending')}</p>
            {account.workspaceLabel === undefined ? null : <p className={css.status}>{t('workspaceNamed', { workspace: account.workspaceLabel })}</p>}
            <div className={css.actions}>
              <Button disabled={busy} onClick={() => { void readStatus(true) }}>{t('verify')}</Button>
              <Button disabled={busy} onClick={() => { void signOut() }}>{t('signOut')}</Button>
            </div>
          </div>
          : <form className={css.group} onSubmit={(event) => { void signIn(event) }}>
            <label className={css.field}>
              <span>{t('username')}</span>
              <Input className={css.input} autoComplete="username" value={username} disabled={busy} onChange={(event) => { setUsername(event.currentTarget.value) }} />
            </label>
            <label className={css.field}>
              <span>{t('password')}</span>
              <Input className={css.input} type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(event) => { setPassword(event.currentTarget.value) }} />
            </label>
            <label className={css.checkbox}>
              <input type="checkbox" checked={registerIfMissing} disabled={busy} onChange={(event) => { setRegisterIfMissing(event.currentTarget.checked) }} />
              <span>{t('registerIfMissing')}</span>
            </label>
            <div className={css.actions}>
              <Button type="submit" variant="primary" disabled={busy || username.trim().length === 0 || password.length === 0}>{busy ? t('signingIn') : t('signIn')}</Button>
            </div>
          </form>}
      {notice === undefined ? null : <p className={css.notice} role="status">{t(notice)}</p>}
    </div>
  )
}
