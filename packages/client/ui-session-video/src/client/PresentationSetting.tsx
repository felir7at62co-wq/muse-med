/** Persistent switch for the independently mounted conversation presentation. */
import { useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PresentationSetting.module.css'

/** Accepted profile settings and writer, independent of the optional UI scope. */
export interface PresentationSettingFace {
  readonly hooks: { readonly presentationSetting: ObservableSnapshot<ConfigFormSnapshot<{ enabled: boolean }>> }
  setEnabled(enabled: boolean): Promise<void>
}

/**
 * Render the always-available switch while the plugin is installed.
 * @param props - Accepted settings, localized copy and persistent writer.
 * @returns The General settings row, including a retained failure notice.
 */
export function PresentationSetting({ usePresentationSetting, setEnabled, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'sessionVideo'> & InjectFace<PresentationSettingFace>) {
  const setting = usePresentationSetting(value => value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return <div className={css.row} data-muse-presentation-setting>
    <div>
      <div className={css.title}>{t('settingTitle')}</div>
      <div className={css.description}>{t('settingDescription')}</div>
      {failed && <div role="alert" className={css.error}>{t('settingError')}</div>}
    </div>
    <Switch checked={setting.value?.enabled ?? false} disabled={busy || !setting.writable || setting.status !== 'ready'}
      label={t('settingTitle')} onChange={(enabled) => {
        setFailed(false); setBusy(true)
        void setEnabled(enabled).catch(() => { setFailed(true) }).finally(() => { setBusy(false) })
      }} />
  </div>
}
