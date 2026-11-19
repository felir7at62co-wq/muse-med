/** Select the installed shared catalog for the asset library panel. */
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { LibraryPage } from './LibraryPage.tsx'

/** Availability of the shared studio catalog in this installation. */
export interface LibraryShellInjected { hooks: { sharedLibrary: HostObservable<boolean> } }

type Props = PropsRuntime<'main'> & PropsLocale<'characterLibrary'> & PropsRenderSlots<'character-library.shared'>
  & InjectFace<LibraryShellInjected>

/**
 * Render the mounted studio catalog directly. Standalone profiles can browse their configured reference store.
 * @param props - Catalog registration, resources and locale.
 * @returns The asset panel for this installation.
 */
export function LibraryShell(props: Props) {
  return props.useSharedLibrary(value => value) ? props.renderSlot('character-library.shared', {}) : <LibraryPage {...props} />
}
