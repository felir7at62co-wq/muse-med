/** muse-med occupants for the browser-brand slots. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { OfficialBrandMark, type BrandInjected } from './Brand.tsx'

/** Required services: UI slots and the resolved application theme. */
export const inject = ['slots', 'theme']

/**
 * Register theme-aware product artwork and synchronize the browser favicon.
 * The sidebar owns the localized product name and source-build metadata.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const logo: BrandInjected['hooks']['logo'] = {
    getSnapshot: () => ctx.theme.getTheme().active.colorScheme === 'dark'
      ? './muse-med-logo-white.webp' : './muse-med-logo-black.webp',
    subscribe: listener => ctx.on('theme/change', listener),
  }
  const inject = (): BrandInjected => ({ hooks: { logo } })
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register({ name: 'sidebar.brand.mark', inject }, OfficialBrandMark))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark', inject }, OfficialBrandMark))
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (icon === null) return
  ctx.effect(() => {
    const { href, type } = icon
    icon.href = './muse-med-logo-black.webp'
    icon.type = 'image/webp'
    return () => { icon.href = href; icon.type = type }
  }, 'muse-med black favicon')
}
