/** MUSE account settings page. Each mount verifies the saved login through the Host without exposing secrets. */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MuseAccountLoginRequest, MuseAccountLoginResult, MuseAccountStatus, MuseAccountStatusRequest } from '@deepseek-ai/dsh-muse-account/types'
import type { MuseAccountLocaleKey } from './locales.ts'
import type { MuseBrowserLoginAttempt, MuseBrowserLoginId, MuseBrowserLoginResult } from '@deepseek-ai/dsh-muse-account/types'
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
  /** Start browser authorization without exposing its private redemption secret. */
  startBrowserLogin: () => Promise<MuseAccountOutcome<MuseBrowserLoginAttempt>>
  /** Redeem only the Host-owned attempt. */
  checkBrowserLogin: (id: MuseBrowserLoginId) => Promise<MuseAccountOutcome<MuseBrowserLoginResult>>
  /** Cancel pending approval and report any commit that already completed. */
  cancelBrowserLogin: (id: MuseBrowserLoginId) => Promise<MuseAccountOutcome<MuseAccountStatus>>
}

/** Full props assembled by the Settings slot renderer. */
export type MuseAccountSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.museAccount'>
  & InjectFace<MuseAccountInjected>
  & { onSignedIn?: () => void }

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
  const { t, status, login, logout, onSignedIn, startBrowserLogin, checkBrowserLogin, cancelBrowserLogin } = props
  const [account, setAccount] = useState<MuseAccountStatus | undefined>(undefined)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [registerIfMissing, setRegisterIfMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<MuseAccountLocaleKey | undefined>(undefined)
  const lifecycle = useRef(0)
  const [browserAttempt, setBrowserAttempt] = useState<MuseBrowserLoginAttempt | undefined>(undefined)
  const activeBrowser = useRef<MuseBrowserLoginId | undefined>(undefined)

  const showStatus = (result: MuseAccountOutcome<MuseAccountStatus>): void => {
    if (result.ok) {
      setAccount(result.value)
      if (result.value.state === 'signed-in') onSignedIn?.()
    } else setNotice(ERROR_COPY[result.code] ?? 'error.generic')
  }

  useEffect(() => {
    const current = ++lifecycle.current
    void status({ verify: true }).then((result) => {
      if (current !== lifecycle.current) return
      showStatus(result)
    }).catch(() => { if (current === lifecycle.current) setNotice('error.generic') })
    return () => {
      lifecycle.current++
      const id = activeBrowser.current
      activeBrowser.current = undefined
      if (id !== undefined) void cancelBrowserLogin(id).catch(() => undefined)
    }
  }, [status])

  useEffect(() => {
    if (browserAttempt === undefined) return
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const result = await checkBrowserLogin(browserAttempt.id)
        if (closed || activeBrowser.current !== browserAttempt.id) return
        if (!result.ok) {
          setNotice(ERROR_COPY[result.code] ?? 'error.generic')
          return
        }
        if (result.value.state === 'pending') {
          timer = setTimeout(() => { void poll() }, browserAttempt.pollIntervalMs)
          return
        }
        activeBrowser.current = undefined
        setBrowserAttempt(undefined)
        if (result.value.state === 'signed-in') {
          setAccount(result.value.status)
          setNotice('signedIn')
          onSignedIn?.()
        } else setNotice(result.value.state === 'expired' ? 'browserExpired' : 'browserCancelled')
      } catch {
        if (!closed) setNotice('error.generic')
      }
    }
    void poll()
    return () => { closed = true; clearTimeout(timer) }
  }, [browserAttempt, checkBrowserLogin])

  const browserSignIn = async (): Promise<void> => {
    if (busy || activeBrowser.current !== undefined) return
    const current = lifecycle.current
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await startBrowserLogin()
      if (current !== lifecycle.current) {
        if (result.ok) await cancelBrowserLogin(result.value.id)
        return
      }
      if (!result.ok) { setNotice(ERROR_COPY[result.code] ?? 'error.generic'); return }
      activeBrowser.current = result.value.id
      setBrowserAttempt(result.value)
      window.open(result.value.authorizeUrl, '_blank', 'noopener,noreferrer')
    } catch {
      if (current === lifecycle.current) setNotice('error.generic')
    } finally {
      if (current === lifecycle.current) setBusy(false)
    }
  }

  const cancelBrowser = async (): Promise<void> => {
    const id = activeBrowser.current
    if (id === undefined) return
    const current = lifecycle.current
    activeBrowser.current = undefined
    setBrowserAttempt(undefined)
    setBusy(true)
    try {
      const result = await cancelBrowserLogin(id)
      if (current === lifecycle.current) {
        showStatus(result)
        if (result.ok) setNotice(result.value.state === 'signed-in' ? 'signedIn' : 'browserCancelled')
      }
    } catch {
      if (current === lifecycle.current) setNotice('error.generic')
    } finally {
      if (current === lifecycle.current) setBusy(false)
    }
  }

  const readStatus = async (): Promise<void> => {
    const current = lifecycle.current
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await status({ verify: true })
      if (current !== lifecycle.current) return
      showStatus(result)
    } catch {
      if (current === lifecycle.current) setNotice('error.generic')
    } finally {
      if (current === lifecycle.current) setBusy(false)
    }
  }

  const signIn = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || username.trim().length === 0 || password.length === 0) return
    const current = lifecycle.current
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await login({ username: username.trim(), password, registerIfMissing })
      if (current !== lifecycle.current) return
      if (result.ok) {
        setAccount(result.value.status)
        onSignedIn?.()
        setRegisterIfMissing(false)
        setNotice(result.value.outcome === 'registered' ? 'registered' : 'signedIn')
      } else {
        setNotice(ERROR_COPY[result.code] ?? 'error.generic')
      }
    } catch {
      if (current === lifecycle.current) setNotice('error.generic')
    } finally {
      if (current === lifecycle.current) {
        setPassword('')
        setBusy(false)
      }
    }
  }

  const signOut = async (): Promise<void> => {
    const current = lifecycle.current
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await logout()
      if (current !== lifecycle.current) return
      if (result.ok) {
        setAccount(result.value)
        setUsername('')
        setNotice('signedOut')
      } else {
        setNotice(ERROR_COPY[result.code] ?? 'error.generic')
      }
    } catch {
      if (current === lifecycle.current) setNotice('error.generic')
    } finally {
      if (current === lifecycle.current) {
        setPassword('')
        setBusy(false)
      }
    }
  }

  return (
    <div className={css.section}>
      <h3 className={css.title}>{t('title')}</h3>
      <p className={css.description}>{t('description')}</p>
      {account === undefined
        ? <div className={css.actions}>
          {notice === undefined ? <p className={css.status} aria-busy="true">{t('loading')}</p> : null}
          {notice === undefined ? null : <Button disabled={busy} onClick={() => { void readStatus() }}>{t('retry')}</Button>}
        </div>
        : account.state === 'signed-in'
          ? <div className={css.group}>
            <p className={css.status}>{t('accountNamed', { username: account.username })}</p>
            <p className={css.status}>{t(account.verified ? 'verified' : 'verificationPending')}</p>
            {account.workspaceLabel === undefined ? null : <p className={css.status}>{t('workspaceNamed', { workspace: account.workspaceLabel })}</p>}
            <div className={css.actions}>
              <Button disabled={busy} onClick={() => { void readStatus() }}>{t('verify')}</Button>
              <Button disabled={busy} onClick={() => { void signOut() }}>{t('signOut')}</Button>
            </div>
          </div>
          : <div className={css.group}>
            {browserAttempt === undefined
              ? <div className={css.actions}>
                <Button variant="primary" disabled={busy} onClick={() => { void browserSignIn() }}>{t('browserSignIn')}</Button>
              </div>
              : <div className={css.group}>
                <p className={css.status} role="status">{t('browserWaiting', { code: browserAttempt.code })}</p>
                <div className={css.actions}>
                  <Button onClick={() => { window.open(browserAttempt.authorizeUrl, '_blank', 'noopener,noreferrer') }}>{t('browserReopen')}</Button>
                  {notice === undefined ? null : <Button onClick={() => { setNotice(undefined); setBrowserAttempt({ ...browserAttempt }) }}>{t('browserCheck')}</Button>}
                  <Button disabled={busy} onClick={() => { void cancelBrowser() }}>{t('browserCancel')}</Button>
                </div>
              </div>}
            {browserAttempt !== undefined ? null : <form className={css.group} onSubmit={(event) => { void signIn(event) }}>
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
          </div>}
      {notice === undefined ? null : <p className={css.notice} role="status">{t(notice)}</p>}
    </div>
  )
}
