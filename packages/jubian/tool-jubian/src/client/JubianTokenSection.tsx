/**
 * Jubian token Settings page, browser half.
 *
 * One form over one `jubianToken` Remote namespace: a password field, Save,
 * Clear, and the credential seam's own status line. The page never receives
 * the token back — every call answers with configured / source / writable — so
 * the field is emptied after a successful write, and the status line is the
 * only evidence that a value is stored.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './JubianTokenSection.module.css'

/**
 * What the Host reports about the stored token. Mirrors the credential seam's
 * `CredentialInfo`, and holds no field a value could ride in.
 */
export interface JubianTokenStatus {
  /** Whether resolving the reference would currently return a value. */
  readonly configured: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  readonly source?: string
  /** Whether this deployment can write the reference. */
  readonly writable: boolean
}

/** What one call resolves to, or the failure it reported. */
export type JubianTokenOutcome =
  | { readonly ok: true; readonly status: JubianTokenStatus }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Registration-side face the page calls; every method reports failures as values. */
export interface JubianTokenInjected {
  /** Read the current status of the stored token. */
  describe: () => Promise<JubianTokenOutcome>
  /**
   * Store one token value.
   * @param value - the non-empty token the person pasted.
   */
  set: (value: string) => Promise<JubianTokenOutcome>
  /** Remove the stored token. */
  unset: () => Promise<JubianTokenOutcome>
}

/** Full component props assembled by the Settings slot renderer. */
export type JubianTokenSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.jubian'>
  & InjectFace<JubianTokenInjected>

/**
 * Human text for one failure.
 *
 * The Host diagnostic is shown as it stands, and a failure that carried none
 * falls back to its stable code, so a new Host failure is visible rather than
 * silently mapped onto an unrelated sentence.
 * @param code - the Remote failure code.
 * @param message - the Host diagnostic.
 * @returns the text to show the user.
 */
function failureText(code: string, message: string): string {
  return message.length > 0 ? message : code
}

/**
 * Render the Jubian token page.
 * @param props - composed slot props (see {@link JubianTokenSectionProps}).
 * @returns the settings page element tree.
 */
export function JubianTokenSection(props: JubianTokenSectionProps): ReactNode {
  const { t, describe, set, unset } = props
  const [status, setStatus] = useState<JubianTokenStatus | undefined>(undefined)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  useEffect(() => {
    let current = true
    void describe().then((outcome) => {
      if (!current) return
      if (outcome.ok) setStatus(outcome.status)
      else setNotice(failureText(outcome.code, outcome.message))
    })
    return () => { current = false }
  }, [describe])

  /**
   * Run one write, then publish the status the Host reports after it. The Host
   * answers with the post-write view, so the page never re-reads to learn what
   * it just did.
   * @param call - the write to run.
   * @param done - the notice a successful write shows.
   */
  const write = (call: () => Promise<JubianTokenOutcome>, done: string): void => {
    setBusy(true)
    setNotice(undefined)
    void call().then((outcome) => {
      setBusy(false)
      if (!outcome.ok) {
        setNotice(t('failed', { reason: failureText(outcome.code, outcome.message) }))
        return
      }
      setStatus(outcome.status)
      setValue('')
      setNotice(done)
    })
  }

  const writable = status?.writable === true
  const configured = status?.configured === true

  return (
    <div className={css.section}>
      {status === undefined
        ? <p className={css.status} aria-busy="true">{t('loading')}</p>
        : (
          <>
            <p className={css.status}>{`${t('statusLabel')}: ${configured ? t('statusConfigured') : t('statusMissing')}`}</p>
            {status.source === undefined ? null : <p className={css.status}>{t('sourceNamed', { source: status.source })}</p>}
            {status.writable ? null : <p className={css.status}>{t('readOnly')}</p>}
            {status.configured ? null : <p className={css.status}>{t('hint')}</p>}
          </>
        )}
      <label className={css.field}>
        <span className={css.label}>{t('fieldLabel')}</span>
        <input
          type="password"
          className={css.input}
          value={value}
          autoComplete="off"
          spellCheck={false}
          aria-label={t('fieldLabel')}
          onChange={(event) => { setValue(event.currentTarget.value) }}
        />
      </label>
      <div className={css.actions}>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !writable || value.trim().length === 0}
          onClick={() => { write(() => set(value), t('saved')) }}
        >
          {busy ? t('saving') : t('save')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !writable || !configured}
          onClick={() => { write(unset, t('cleared')) }}
        >
          {t('clear')}
        </Button>
      </div>
      {notice === undefined ? null : <p className={css.notice} role="status">{notice}</p>}
    </div>
  )
}
