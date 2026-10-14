/** Browser registration for the read-only character reference page. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { characterLibraryDefinition, LIBRARY_ID } from './definition.tsx'
import { CharacterLibraryTab, CharacterLibraryTitle } from './tab.tsx'
import { en, zh } from './locales.ts'

export const inject = ['slots', 'locale', 'sidebarRightTabs']

/** @param ctx - Injected browser registries. @returns Nothing; disposal removes the page and its copy. */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind('characterLibrary')
  ctx.effect(() => ctx.locale.register('characterLibrary', { zh, en }), 'character-library: copy')
  ctx.effect(() => ctx.sidebarRightTabs.register(characterLibraryDefinition(t)), 'character-library: page')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: LIBRARY_ID, locale: 'characterLibrary' }, CharacterLibraryTab,
  )), 'character-library: body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: LIBRARY_ID }, CharacterLibraryTitle,
  )), 'character-library: title')
}
