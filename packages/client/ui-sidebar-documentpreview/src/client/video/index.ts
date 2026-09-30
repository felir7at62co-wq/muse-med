/** Video renderer registration using Session-scoped metadata and authenticated streaming. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { SessionFile } from '../rpc.ts'
import { VideoBody, type VideoBodyInjected } from './VideoBody.tsx'
import { en, zh } from './locales.ts'

/** Key shared by video metadata and its document body. */
export const VIDEO_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/video'

/**
 * Build a Session-scoped video URL on the current authenticated app origin.
 * @param file - Addressed Session and workspace-relative or absolute path.
 * @param pageUrl - Current browser or Desktop app URL.
 * @param version - Optional source version obtained through authorized metadata lookup.
 * @returns Same-origin video endpoint; credentials are never encoded in its query.
 */
export function videoUrl(file: SessionFile, pageUrl: string, version?: string): string {
  const url = new URL('/api/video', pageUrl)
  url.searchParams.set('sessionId', file.sessionId)
  url.searchParams.set('path', file.path)
  if (version !== undefined) url.searchParams.set('version', version)
  return url.href
}

/**
 * Register native video controls without complete-file loading.
 * @param ctx - Existing document registry, locale, slots and workspace Remote.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('sidebarVideo', { zh, en }), 'document-video: dictionaries')
  const t = ctx.locale.bind('sidebarVideo')
  const extensions = ['mp4', 'm4v', 'webm', 'mov']
  ctx.effect(() => ctx.documentPreviews.register({ id: VIDEO_BODY_ID, extensions, binaryExtensions: extensions,
    priority: 'builtin', title: () => t('title'), loading: 'renderer', wrap: false,
  }), 'document-video: metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: VIDEO_BODY_ID, locale: 'sidebarVideo',
    inject: (): VideoBodyInjected => ({ resolveSource: async (file, signal) => {
      const result = await ctx.remote.workspaceFiles.stat(file.sessionId, file.path, signal)
      signal.throwIfAborted()
      if (!result.ok) throw new Error(t('unavailable'))
      return { url: videoUrl(file, window.location.href, result.value.version), version: result.value.version }
    } }),
  }, VideoBody)), 'document-video: body')
}
