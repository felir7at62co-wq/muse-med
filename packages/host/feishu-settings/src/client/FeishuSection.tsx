/**
 * Feishu Settings page, browser half.
 *
 * One page over the `feishuSetup` Remote namespace: the product switch, the
 * state the running composition actually reports, the scan ticket the Host
 * rendered, and a hand-entry fallback for an app that already exists. The page
 * never receives the stored secret — every answer carries the app id and
 * whether a secret is stored — and every failure is shown as its code.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FeishuLoginTicket, FeishuRowState, FeishuSetupStatus } from '../types.ts'
import type { FeishuLocaleKey } from './locales.ts'
import css from './FeishuSection.module.css'

/** What one call resolved to, or the failure code it reported. */
export type FeishuOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Registration-side face the page calls; every method reports failures as values. */
export interface FeishuSetupInjected {
  /** Read the stored switch, the effective row state, and any pending scan. */
  status: () => Promise<FeishuOutcome<FeishuSetupStatus>>
  /** Store the product switch. */
  setEnabled: (enabled: boolean) => Promise<FeishuOutcome<FeishuSetupStatus>>
  /** Store a hand-entered pair; an empty secret keeps the stored one. */
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

/** Copy key of each failure code this Host answers with. */
const CODE_COPY: Record<string, FeishuLocaleKey> = {
  'registration-failed': 'error.registration-failed',
  'invalid_request': 'error.invalid_request',
  'no-qr': 'error.no-qr',
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
      else {
        const key = CODE_COPY[outcome.code]
        setNotice(key === undefined ? t('error.generic', { code: outcome.code }) : t(key))
      }
    })
    return () => {
      current = false
    }
  }, [readStatus, t])

  /**
   * Run one call that answers with the post-write status.
   * @param call - the call to run.
   * @param done - the notice a successful call shows; undefined shows none.
   */
  const run = (call: () => Promise<FeishuOutcome<FeishuSetupStatus>>, done?: FeishuLocaleKey): void => {
    setBusy(true)
    setNotice(undefined)
    void call().then((outcome) => {
      setBusy(false)
      if (!outcome.ok) {
        const key = CODE_COPY[outcome.code]
        setNotice(key === undefined ? t('error.generic', { code: outcome.code }) : t(key))
        return
      }
      setStatus(outcome.value)
      if (done !== undefined) setNotice(t(done))
    })
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
      const key = CODE_COPY[outcome.code]
      setNotice(key === undefined ? t('error.generic', { code: outcome.code }) : t(key))
      return
    }
    const refreshed = await readStatus()
    setBusy(false)
    if (refreshed.ok) setStatus(refreshed.value)
  }

  if (status === undefined) return <div className={css.section}><p aria-busy="true">{t('nav')}</p></div>

  return (
    <div className={css.section}>
      <p className={css.status}>{`${t('statusLabel')}: ${t(ROW_COPY[status.row])}`}</p>
      <p className={css.hint}>{t('credentialLabel')}: {t(status.credential === 'none' ? 'credential.none' : status.credential === 'manual' ? 'credential.manual' : 'credential.registered')}</p>
      {status.appId.length === 0 ? null : <p className={css.hint}>{`${t('appIdLabel')}: ${status.appId}`}</p>}
      {notice === undefined ? null : <p className={css.notice}>{notice}</p>}

      <label className={css.switch}>
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={busy}
          onChange={(event) => {
            run(async () => await setEnabled(event.target.checked), 'switchNeedsRestart')
          }}
        />
        {t('switchLabel')}
      </label>

      <h3 className={css.heading}>{t('qrTitle')}</h3>
      <p className={css.hint}>{t('qrHint')}</p>
      {status.login === null
        ? <Button disabled={busy} onClick={() => { void startScan() }}>{busy ? t('qrStarting') : t('qrStart')}</Button>
        : (
          <div className={css.qr}>
            <img className={css.qrImage} src={status.login.qrDataUrl} alt={t('qrWaiting')} />
            <p className={css.hint}>
              {secondsLeft === null || secondsLeft > 0 ? t('qrExpires', { seconds: String(secondsLeft ?? status.login.expiresInSeconds) }) : t('qrExpired')}
            </p>
            <div className={css.actions}>
              <Button disabled={busy} onClick={() => { void startScan() }}>{t('qrRefresh')}</Button>
              <Button disabled={busy} onClick={() => { run(async () => await cancelLogin()) }}>{t('qrCancel')}</Button>
            </div>
          </div>
        )}

      <h3 className={css.heading}>{t('advancedTitle')}</h3>
      <p className={css.hint}>{t('advancedHint')}</p>
      <label className={css.field}>
        {t('appIdLabel')}
        <input value={appId} placeholder={t('appIdPlaceholder')} onChange={(event) => { setAppId(event.target.value) }} />
      </label>
      <label className={css.field}>
        {t('secretLabel')}
        <input
          type="password"
          value={appSecret}
          placeholder={status.credential === 'none' ? t('secretPlaceholder') : t('secretStored')}
          onChange={(event) => { setAppSecret(event.target.value) }}
        />
      </label>
      <div className={css.actions}>
        <Button
          disabled={busy || appId.trim().length === 0}
          onClick={() => {
            run(async () => await setCredentials({ appId: appId.trim(), appSecret }), 'saved')
            setAppSecret('')
          }}
        >
          {busy ? t('saving') : t('save')}
        </Button>
        <Button disabled={busy} onClick={() => { run(async () => await forget(), 'forgotten'); setAppId(''); setAppSecret('') }}>
          {busy ? t('forgetting') : t('forget')}
        </Button>
      </div>
    </div>
  )
}
