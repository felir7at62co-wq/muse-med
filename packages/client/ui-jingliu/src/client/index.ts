/** Production and writing workbench guide entries and tabs for the right sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-muse-account/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { IconEditOutlineRegular, IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { EDITOR_URL_GLOBAL, STUDIO_URL_GLOBAL, WORKSHOP_URL_GLOBAL } from '../page.ts'
import type { WorkbenchLoginResult } from './workbench-login.ts'
import { EditorStudio } from './EditorStudio.tsx'
import { cutImportActions } from './cut-import-actions.ts'
import { Studio } from './Studio.tsx'
import { en, zh, ja, es, fr, de, ru, pt } from './locales.ts'

/** Required client services when the studio URL is present. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Register the guide after the files, terminal and browser entries.
 * @param ctx - Client extension registries.
 */
export function apply(ctx: Context): void {
  const bootstrap = globalThis as Partial<Record<typeof EDITOR_URL_GLOBAL | typeof STUDIO_URL_GLOBAL | typeof WORKSHOP_URL_GLOBAL, string>>
  const entries = [
    { url: bootstrap[STUDIO_URL_GLOBAL], id: '@deepseek-ai/dsh-client-ui-jingliu', kind: 'jingliu',
      title: 'title', description: 'workbench', order: 40, icon: IconPlayOutlineRegular },
    { url: bootstrap[WORKSHOP_URL_GLOBAL], id: '@deepseek-ai/dsh-client-ui-jingliu/workshop', kind: 'script-workshop',
      title: 'workshopTitle', description: 'workshopDescription', order: 50, icon: IconEditOutlineRegular },
  ] as const
  const editorUrl = bootstrap[EDITOR_URL_GLOBAL]
  if (!editorUrl && !entries.some(entry => entry.url)) return
  type Issue = (audience: 'jingliu' | 'script-workshop', challenge: string) => Promise<WorkbenchLoginResult>
  const loginGeneration = createSnapshotStore(0)
  const reset = (): void => { loginGeneration.set(loginGeneration.getSnapshot() + 1) }
  let issue: Issue | undefined
  ctx.inject(['remote.museAccount'], scope => scope.effect(() => {
    issue = async (audience, challenge) => {
      const result = await scope.remote.museAccount.issueWorkbenchCode({ audience, challenge })
      if (result.ok) return { code: result.value.code }
      return { error: result.error.code === 'muse-workbench/sign-in-required' ? 'sign-in-required' : 'unavailable' }
    }
    const off = scope.remote.$on('muse-account/session-changed', reset)
    const onReset = scope.on('connection/reset', reset)
    reset()
    return () => { issue = undefined; off(); onReset(); reset() }
  }, 'workbenches: account login'))
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
    const issueLogin = async (challenge: string): Promise<WorkbenchLoginResult> => issue ? await issue(kind, challenge) : { error: 'unavailable' }
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: id, locale, inject: () => ({ studioUrl: url, titleKey: title, issueLogin, hooks: { loginGeneration } }),
    }, Studio)), `${kind}: document`)
  }
  if (editorUrl) {
    const id = '@deepseek-ai/dsh-client-ui-jingliu/editor'
    ctx.effect(() => ctx.sidebarRightTabs.register({
      id, kind: 'openchatcut', priority: 'builtin', keepMounted: true, title: () => t('editorTitle'),
      guide: [{ id: 'editor', order: 45, title: () => t('editorTitle'), description: () => t('editorDescription'), icon: IconEditOutlineRegular }],
    }), 'editor: guide')
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: id, locale,
      inject: () => ({
        editorUrl, canImport: Boolean(bootstrap[STUDIO_URL_GLOBAL]), actions: cutImportActions(), hooks: { loginGeneration },
      }),
    }, EditorStudio)), 'editor: document')
  }
}
