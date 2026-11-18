/** Jingliu studio guide entry and tab for the right sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { STUDIO_URL_GLOBAL } from '../page.ts'
import { Studio } from './Studio.tsx'
import { en, zh, ja, es, fr, de, ru, pt } from './locales.ts'

/** Required client services when the studio URL is present. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Register the guide after the files, terminal and browser entries.
 * @param ctx - Client extension registries.
 */
export function apply(ctx: Context): void {
  const url = (globalThis as Partial<Record<typeof STUDIO_URL_GLOBAL, string>>)[STUDIO_URL_GLOBAL]
  if (!url) return
  if (new URL(url).origin === location.origin) throw new Error('Jingliu requires a separate studio origin.')
  const id = '@deepseek-ai/dsh-client-ui-jingliu'
  const locale = 'jingliuStudio'
  const t = ctx.locale.bind(locale)
  ctx.effect(() => ctx.locale.register(locale, { en, zh, ja, es, fr, de, ru, pt }), 'jingliu: copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id, kind: 'jingliu', priority: 'builtin', keepMounted: true, title: () => t('title'),
    guide: [{ id: 'studio', order: 40, title: () => t('title'), description: () => t('workbench'), icon: IconPlayOutlineRegular }],
  }), 'jingliu: guide')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: id, locale, inject: () => ({ studioUrl: url }),
  }, Studio)), 'jingliu: document')
}
