/** Production and writing workbench guide entries and tabs for the right sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { IconEditOutlineRegular, IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { STUDIO_URL_GLOBAL, WORKSHOP_URL_GLOBAL } from '../page.ts'
import { Studio } from './Studio.tsx'
import { en, zh, ja, es, fr, de, ru, pt } from './locales.ts'

/** Required client services when the studio URL is present. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Register the guide after the files, terminal and browser entries.
 * @param ctx - Client extension registries.
 */
export function apply(ctx: Context): void {
  const bootstrap = globalThis as Partial<Record<typeof STUDIO_URL_GLOBAL | typeof WORKSHOP_URL_GLOBAL, string>>
  const entries = [
    { url: bootstrap[STUDIO_URL_GLOBAL], id: '@deepseek-ai/dsh-client-ui-jingliu', kind: 'jingliu',
      title: 'title', description: 'workbench', order: 40, icon: IconPlayOutlineRegular },
    { url: bootstrap[WORKSHOP_URL_GLOBAL], id: '@deepseek-ai/dsh-client-ui-jingliu/workshop', kind: 'script-workshop',
      title: 'workshopTitle', description: 'workshopDescription', order: 50, icon: IconEditOutlineRegular },
  ] as const
  const locale = 'jingliuStudio'
  const t = ctx.locale.bind(locale)
  ctx.effect(() => ctx.locale.register(locale, { en, zh, ja, es, fr, de, ru, pt }), 'workbenches: copy')
  for (const { url, id, kind, title, description, order, icon } of entries) {
    if (!url) continue
    if (new URL(url).origin === location.origin) throw new Error(`${kind} requires a separate workbench origin.`)
    ctx.effect(() => ctx.sidebarRightTabs.register({
      id, kind, priority: 'builtin', keepMounted: true, title: () => t(title),
      guide: [{ id: 'studio', order, title: () => t(title), description: () => t(description), icon }],
    }), `${kind}: guide`)
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: id, locale, inject: () => ({ studioUrl: url, titleKey: title }),
    }, Studio)), `${kind}: document`)
  }
}
