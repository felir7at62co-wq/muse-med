/** Switch between Muse character references and a registered shared production library. */
import { useState } from 'react'
import { SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { LibraryPage } from './LibraryPage.tsx'
import css from './LibraryPage.module.css'

/** Live availability of the shared studio tab. */
export interface LibraryShellInjected { hooks: { sharedLibrary: HostObservable<boolean> } }

type Props = PropsRuntime<'main'> & PropsLocale<'characterLibrary'> & PropsRenderSlots<'character-library.shared'>
  & InjectFace<LibraryShellInjected>

/**
 * Show shared assets and character references in one library.
 * @param props - Library occupancy, resource hooks and locale.
 * @returns The combined asset library.
 */
export function LibraryShell(props: Props) {
  const available = props.useSharedLibrary(value => value)
  const [selected, setSelected] = useState<'shared' | 'characters'>('shared')
  if (!available) return <LibraryPage {...props} />
  const tabs = [
    { value: 'shared' as const, label: props.t('sharedLibrary'), id: 'library-tab-cloud', panelId: 'library-panel' },
    { value: 'characters' as const, label: props.t('title'), id: 'library-tab-characters', panelId: 'library-panel' },
  ] as const
  return <div className={css.shell}>
    <div className={css.switcher}><SegmentedTabs items={tabs} value={selected} onChange={setSelected} label={props.t('assetLibrary')} size="sm" /></div>
    <div className={css.content} role="tabpanel" id="library-panel" aria-labelledby={tabs[selected === 'shared' ? 0 : 1]?.id}>
      {selected === 'shared' ? props.renderSlot('character-library.shared', {}) : <LibraryPage {...props} />}
    </div>
  </div>
}
