/** Sidebar adapter for the deployment's unconfigured read-only browser source. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { CharacterLibraryBody } from './CharacterLibraryBody.tsx'
import { defaultLibraryBrowserSource } from './catalog.ts'
import type {} from './locales.ts'

/** @param props - Framework-owned locale share. @returns The browser, without a catalog or any write capability. */
export function CharacterLibraryTab({ t }: PropsLocale<'characterLibrary'>) {
  return <CharacterLibraryBody source={defaultLibraryBrowserSource} t={t} />
}

/** @param props - Framework-owned tab information. @returns The shared person icon and localized tab title. */
export function CharacterLibraryTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
  const { tab } = useTabInfo()
  return <><IconUserOutlineRegular size={16} />{tab.title}</>
}
