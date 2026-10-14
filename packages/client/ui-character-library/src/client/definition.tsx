/** The character reference browser is a page, not a project asset editor. */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from './locales.ts'

/** Page kind owned by the reference browser. */
export const LIBRARY_KIND = 'character-library'
/** Implementation identity used for keyed Sidebar seats. */
export const LIBRARY_ID = '@deepseek-ai/dsh-client-ui-character-library'

/** @param t - Current locale translator. @returns One read-only guide entry with no resource claims. */
export function characterLibraryDefinition(t: TranslateNS<'characterLibrary'>): SidebarRightTabDefinition {
  return {
    id: LIBRARY_ID, kind: LIBRARY_KIND, priority: 'builtin', title: () => t('title'),
    guide: [{ id: 'character-library', order: 25, title: () => t('title'),
      description: () => t('guideDescription'), icon: IconUserOutlineRegular }],
  }
}
