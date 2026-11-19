/** Jingliu production project and studio entries for the right sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-muse-account/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { STUDIO_URL_GLOBAL } from '../page.ts'
import type { WorkbenchLoginResult } from './workbench-login.ts'
import { installNative } from './native.ts'
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
  const locale = 'jingliuStudio'
  const t = ctx.locale.bind(locale)
  ctx.effect(() => ctx.locale.register(locale, { en, zh, ja, es, fr, de, ru, pt }), 'jingliu: copy')
  const studio = new URL(url)
  if (studio.pathname === '/jingliu/') {
    installNative(ctx)
    return
  }
  if (studio.origin === location.origin) throw new Error('Jingliu requires a separate workbench origin.')
  type Issue = (challenge: string) => Promise<WorkbenchLoginResult>
  const loginGeneration = createSnapshotStore(0)
  const reset = (): void => { loginGeneration.set(loginGeneration.getSnapshot() + 1) }
  let issue: Issue | undefined
  ctx.inject(['remote.museAccount'], scope => scope.effect(() => {
    issue = async (challenge) => {
      const result = await scope.remote.museAccount.issueWorkbenchCode({ audience: 'jingliu', challenge })
      if (result.ok) return { code: result.value.code }
      return { error: result.error.code === 'muse-workbench/sign-in-required' ? 'sign-in-required' : 'unavailable' }
    }
    const off = scope.remote.$on('muse-account/session-changed', reset)
    const onReset = scope.on('connection/reset', reset)
    reset()
    return () => { issue = undefined; off(); onReset(); reset() }
  }, 'workbenches: account login'))
  const id = '@deepseek-ai/dsh-client-ui-jingliu'
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id, kind: 'jingliu', priority: 'builtin', keepMounted: true, title: () => t('title'),
    guide: [{ id: 'studio', order: 40, title: () => t('title'), description: () => t('workbench'), icon: IconPlayOutlineRegular }],
  }), 'jingliu: guide')
  const issueLogin: Issue = async challenge => issue ? await issue(challenge) : { error: 'unavailable' }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: id, locale, inject: () => ({ studioUrl: url, issueLogin, hooks: { loginGeneration } }),
  }, Studio)), 'jingliu: document')
}
