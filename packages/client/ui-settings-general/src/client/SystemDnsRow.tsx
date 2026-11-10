/** Device-local Electron resolver preference and save feedback. */
import { Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SystemDnsView } from './system-dns-source.ts'
import css from './DeveloperToolsRow.module.css'

/** Accepted preference and commands supplied by the Desktop bridge owner. */
export interface SystemDnsInjected {
  hooks: { systemDns: ObservableSnapshot<SystemDnsView> }
  setEnabled(enabled: boolean): Promise<void>
  reload(): Promise<void>
  dismiss(): void
}

type Face = InjectFace<SystemDnsInjected> & PropsLocale<'settings'>

/** Render the resolver preference and indicate when a restart is needed. */
export function SystemDnsRow({ useSystemDns, setEnabled, reload, t }: PropsRuntime<'settings.general.item'> & Face) {
  const state = useSystemDns(value => value)
  return <div className={css.row}>
    <div>
      <div className={css.title}>{t('systemDns.title')}</div>
      <div className={css.description}>{t('systemDns.description')}</div>
      {state.preference !== undefined && state.preference.saved !== state.preference.active &&
        <div className={css.description}>{t('systemDns.restart')}</div>}
      {state.unknown && <div role="alert">{t('systemDns.unknown')} <button type="button" disabled={state.loading} onClick={() => { void reload() }}>
        {t('systemDns.retry')}
      </button></div>}
      {state.loadFailed && !state.unknown && <div role="alert">{t('systemDns.loadError')} <button type="button" onClick={() => { void reload() }}>
        {t('systemDns.retry')}
      </button></div>}
    </div>
    {!state.unknown && <Switch checked={state.preference?.saved === true} label={t('systemDns.title')}
      disabled={state.loading || state.busy || state.preference === undefined}
      onChange={(enabled) => { void setEnabled(enabled) }} />}
  </div>
}

/** Keep save feedback visible after the Settings panel closes. */
export function SystemDnsToast({ useSystemDns, dismiss, t }: PropsRuntime<'shell.overlay'> & Face) {
  const state = useSystemDns(value => value)
  if (state.notice === null) return null
  const message = state.notice === 'saved' ? 'systemDns.saved' : state.notice === 'failed' ? 'systemDns.saveError' : 'systemDns.unknown'
  return <Toast key={state.noticeSequence} text={t(message)}
    onDone={dismiss} {...state.notice === 'saved' ? { tone: 'success' as const } : {}} />
}
