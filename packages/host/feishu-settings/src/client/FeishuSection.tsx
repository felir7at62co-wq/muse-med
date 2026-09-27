/**
 * Feishu Settings page, browser half.
 *
 * One page over the `feishuSetup` Remote namespace: the product switch, the
 * state the running composition actually reports, the scan ticket the Host
 * rendered, and a hand-entry fallback for an app that already exists. The page
 * never receives the stored secret — every answer carries the app id and
 * whether a secret is stored — and every refusal is shown as the reason the
 * Host named, never as the settings service's own message.
 *
 * A refused save leaves both fields as typed, so the same page can be corrected
 * and retried; only a landed write clears the secret.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { FeishuCredentialFailure, FeishuLoginTicket, FeishuRowState, FeishuSetupStatus } from '../types.ts'
import type { FeishuLocaleKey } from './locales.ts'
import css from './FeishuSection.module.css'

/** What one call resolved to, or the refusal it reported. */
export type FeishuOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailure }

/** Registration-side face the page calls; every method reports failures as values. */
export interface FeishuSetupInjected {
  /** Read the stored switch, the effective row state, and any pending scan. */
  status: () => Promise<FeishuOutcome<FeishuSetupStatus>>
  /** Store the product switch. */
  setEnabled: (enabled: boolean) => Promise<FeishuOutcome<FeishuSetupStatus>>
  /** Store a hand-entered pair; an empty secret keeps a stored one. */
  setCredentials: (request: { readonly appId: string; readonly appSecret: string }) => Promise<FeishuOutcome<FeishuSetupStatus>>
  /** Start one scan. */
  beginLogin: () => Promise<FeishuOutcome<FeishuLoginTicket>>
  /** Withdraw the pending scan. */
  cancelLogin: () => Promise<FeishuOutcome<FeishuSetupStatus>>
  /** Forget the stored pair and turn the switch off. */
  forget: () => Promise<FeishuOutcome<FeishuSetupStatus>>
}

/** Full component props assembled by the Settings slot renderer. */
export type FeishuSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.feishu'>
  & InjectFace<FeishuSetupInjected>

/** Copy key of each effective row state. */
const ROW_COPY: Record<FeishuRowState, FeishuLocaleKey> = {
  'disabled': 'status.disabled',
  'restart-pending': 'status.restartPending',
  'active': 'status.active',
  'overridden': 'status.overridden',
  'unavailable': 'status.unavailable',
}

/** Copy key of each reason a credential write can be refused with. */
const REASON_COPY: Record<FeishuCredentialFailure, FeishuLocaleKey> = {
  'section-unregistered': 'error.sectionUnregistered',
  'provider-read-only': 'error.providerReadOnly',
  'write-rejected': 'error.writeRejected',
}

/** Copy key of each bounded code the platform's registration call reports. */
const LOGIN_COPY: Record<string, FeishuLocaleKey> = {
  'registration-failed': 'error.registration-failed',
  'invalid_request': 'error.invalid_request',
  'no-qr': 'error.no-qr',
}

/**
 * Render one refusal as copy this page owns.
 * @param error - the typed failure the Host reported.
 * @param t - the page's bound copy.
 * @returns the sentence to show.
 */
function failureText(error: RemoteFailure, t: FeishuSectionProps['t']): string {
  switch (error.code) {
    case 'feishu/credentials-unwritable':
      return t(REASON_COPY[error.details.reason])
    case 'feishu/secret-required':
      return t('error.secretRequired')
    case 'feishu/login-failed': {
      const known = LOGIN_COPY[error.details.code]
      return known === undefined ? t('error.loginFailed', { code: error.details.code }) : t(known)
    }
    default:
      // A carrier or infrastructure failure: its code is the whole fact this
      // page can honestly show.
      return t('error.generic', { code: error.code })
  }
}

/** Seconds in the platform's validity window, ticked down locally. */
function useCountdown(ticket: FeishuLoginTicket | null | undefined): number | null {
  const [seconds, setSeconds] = useState<number | null>(null)
  useEffect(() => {
    if (ticket === null || ticket === undefined) {
      setSeconds(null)
      return
    }
    setSeconds(ticket.expiresInSeconds)
    const timer = setInterval(() => {
      setSeconds(current => (current === null || current <= 0 ? current : current - 1))
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [ticket])
  return seconds
}

/**
 * Render the Feishu settings page.
 * @param props - composed slot props (see {@link FeishuSectionProps}).
 * @returns the settings page element tree.
 */
export function FeishuSection(props: FeishuSectionProps): ReactNode {
  const { t, status: readStatus, setEnabled, setCredentials, beginLogin, cancelLogin, forget } = props
  const [status, setStatus] = useState<FeishuSetupStatus | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const secondsLeft = useCountdown(status?.login)

  useEffect(() => {
    let current = true
    void readStatus().then((outcome) => {
      if (!current) return
      if (outcome.ok) setStatus(outcome.value)
      else setNotice(failureText(outcome.error, t))
    })
    return () => {
      current = false
    }
  }, [readStatus, t])

  /**
   * Run one call, report its refusal, and adopt the status it answers with.
   * @param call - the call to run.
   * @param done - the notice a landed call shows; undefined shows none.
   * @returns nothing; the page state is updated.
   */
  const run = async (call: () => Promise<FeishuOutcome<FeishuSetupStatus>>, done?: FeishuLocaleKey): Promise<boolean> => {
    setBusy(true)
    setNotice(undefined)
    const outcome = await call()
    setBusy(false)
    if (!outcome.ok) {
      setNotice(failureText(outcome.error, t))
      return false
    }
    setStatus(outcome.value)
    if (done !== undefined) setNotice(t(done))
    return true
  }

  /**
   * Request a fresh ticket, then re-read the status that carries it.
   * @returns nothing; the page state is updated.
   */
  const startScan = async (): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    const outcome = await beginLogin()
    if (!outcome.ok) {
      setBusy(false)
      setNotice(failureText(outcome.error, t))
      return
    }
    const refreshed = await readStatus()
    setBusy(false)
    if (refreshed.ok) setStatus(refreshed.value)
  }

  if (status === undefined) {
    // A first read that was refused has no status to render; the reason it
    // carries is the whole page until the Host answers one.
    return (
      <div className={css.section}>
        <p className={css.notice} aria-busy="true">{t('nav')}</p>
        {notice === undefined ? null : <p className={css.notice} role="status">{notice}</p>}
      </div>
    )
  }

  // A secret is required exactly while none is stored: the write keeps a stored
  // one when the field is blank, so the field only looks optional after one.
  const hasStoredSecret = status.credential !== 'none'

  return (
    <div className={css.section}>
      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('statusLabel')}</h3>
        <p className={css.groupDescription}>{t(ROW_COPY[status.row])}</p>
        <p className={css.groupDescription}>
          {`${t('credentialLabel')}: ${t(hasStoredSecret ? (status.credential === 'manual' ? 'credential.manual' : 'credential.registered') : 'credential.none')}`}
        </p>
        {status.appId.length === 0 ? null : <p className={css.groupDescription}>{`${t('appIdLabel')}: ${status.appId}`}</p>}
      </section>

      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('switchLabel')}</h3>
        <div className={css.toggleRow}>
          <Switch
            checked={status.enabled}
            disabled={busy || !status.writable}
            label={t('switchLabel')}
            onChange={(next) => { void run(async () => await setEnabled(next), 'switchNeedsRestart') }}
          />
          <span className={css.groupDescription}>{t('switchHint')}</span>
        </div>
      </section>

      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('qrTitle')}</h3>
        <p className={css.groupDescription}>{t('qrHint')}</p>
        {status.login === null
          ? <div className={css.actions}><Button disabled={busy} onClick={() => { void startScan() }}>{busy ? t('qrStarting') : t('qrStart')}</Button></div>
          : (
            <div className={css.qr}>
              <img className={css.qrImage} src={status.login.qrDataUrl} alt={t('qrWaiting')} />
              <p className={css.groupDescription}>
                {secondsLeft === null || secondsLeft > 0 ? t('qrExpires', { seconds: String(secondsLeft ?? status.login.expiresInSeconds) }) : t('qrExpired')}
              </p>
              <div className={css.actions}>
                <Button disabled={busy} onClick={() => { void startScan() }}>{t('qrRefresh')}</Button>
                <Button disabled={busy} onClick={() => { void run(async () => await cancelLogin()) }}>{t('qrCancel')}</Button>
              </div>
            </div>
          )}
      </section>

      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('advancedTitle')}</h3>
        <p className={css.groupDescription}>{t('advancedHint')}</p>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('appIdLabel')}</span>
          <Input
            className={css.input}
            value={appId}
            placeholder={t('appIdPlaceholder')}
            aria-label={t('appIdLabel')}
            onChange={(event) => { setAppId(event.target.value) }}
          />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('secretLabel')}</span>
          <Input
            className={css.input}
            type="password"
            value={appSecret}
            placeholder={hasStoredSecret ? t('secretKeepStored') : t('secretPlaceholder')}
            aria-label={t('secretLabel')}
            onChange={(event) => { setAppSecret(event.target.value) }}
          />
        </label>
        {hasStoredSecret ? null : <p className={css.groupDescription}>{t('secretRequiredHint')}</p>}
        <div className={css.actions}>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !status.writable || appId.trim().length === 0 || (!hasStoredSecret && appSecret.length === 0)}
            onClick={() => {
              setBusy(true)
              setNotice(undefined)
              void setCredentials({ appId: appId.trim(), appSecret }).then((outcome) => {
                setBusy(false)
                // A refused write keeps the fields as typed: the secret is what
                // the retry needs, and it is the one value the page cannot
                // reconstruct.
                if (!outcome.ok) {
                  setNotice(failureText(outcome.error, t))
                  return
                }
                setStatus(outcome.value)
                setAppSecret('')
                setNotice(t('saved'))
              })
            }}
          >
            {busy ? t('saving') : t('save')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !status.writable}
            onClick={() => {
              void run(forget, 'forgotten').then((landed) => {
                if (!landed) return
                setAppId('')
                setAppSecret('')
              })
            }}
          >
            {busy ? t('forgetting') : t('forget')}
          </Button>
        </div>
      </section>

      {notice === undefined ? null : <p className={css.notice} role="status">{notice}</p>}
      {status.writable ? null : <p className={css.notice}>{t('readOnly')}</p>}
    </div>
  )
}
