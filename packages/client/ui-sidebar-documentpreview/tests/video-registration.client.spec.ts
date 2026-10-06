// @vitest-environment jsdom
/** Video registration owns metadata lookup, same-origin sources and unload through the real registries. */
import { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { apply, VIDEO_BODY_ID } from '../src/client/video/index.ts'
import { VideoBody, type VideoBodyInjected } from '../src/client/video/VideoBody.tsx'
import { en } from '../src/client/video/locales.ts'

it('resolves authorized versions, refuses missing files, cancels late metadata and removes every contribution', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  locale.setLocale('en')
  const registry = new DocumentPreviewRegistry()
  ctx.provide('documentPreviews', registry)
  const stat = vi.fn<ClientRemote['workspaceFiles']['stat']>()
  ctx.provide('remote', { workspaceFiles: { stat } } as never)
  const slots = ctx.get('slots') as SlotRegistry
  const feature = ctx.plugin({ inject: ['slots', 'locale', 'documentPreviews', 'remote'], apply })
  await feature.await()
  expect(slots.entries('sidebar.right.tab.document')).toEqual([])
  const declare = slots.register({ name: 'root', children: {
    'sidebar.right.tab.document': { kind: 'keyed', scope: 'session' },
  } } as never, () => null)
  onTestFinished(declare)
  expect(registry.getSnapshot()[0]?.title()).toBe(en.title)
  for (const extension of ['mp4', 'm4v', 'webm', 'mov']) {
    expect(registry.candidates(`CLIP.${extension}`)[0]?.id).toBe(VIDEO_BODY_ID)
  }
  const entry = slots.entries('sidebar.right.tab.document')[0]!
  expect(entry.component).toBe(VideoBody)
  const face = entry.inject!() as VideoBodyInjected & Record<string, unknown>
  const file = { sessionId: SessionId('video-registration'), path: 'clip.mp4' }
  const metadata = { absolutePath: '/work/clip.mp4', version: 'v1', bytes: 20 }
  stat.mockResolvedValueOnce({ ok: true, value: metadata })
  const source = await face.resolveSource(file, new AbortController().signal)
  expect(source.version).toBe('v1')
  expect(new URL(source.url).origin).toBe(new URL(document.baseURI).origin)
  expect(new URL(source.url).searchParams.get('version')).toBe('v1')
  expect(stat).toHaveBeenCalledExactlyOnceWith(file.sessionId, file.path, expect.any(AbortSignal))
  stat.mockResolvedValueOnce({ ok: false, error: new RemoteError('workspace-file/not-found', 'private path diagnostic', { path: file.path }) })
  await expect(face.resolveSource(file, new AbortController().signal)).rejects.toThrow(en.unavailable)
  let settle!: (result: Awaited<ReturnType<ClientRemote['workspaceFiles']['stat']>>) => void
  const pending = new Promise<Awaited<ReturnType<ClientRemote['workspaceFiles']['stat']>>>((yes) => { settle = yes })
  stat.mockImplementationOnce(() => pending)
  const controller = new AbortController()
  const request = face.resolveSource(file, controller.signal)
  const rejected = expect(request).rejects.toThrow('cancelled')
  controller.abort(new Error('cancelled'))
  settle({ ok: true, value: metadata })
  await rejected
  await feature.dispose()
  expect(registry.getSnapshot()).toEqual([])
  expect(slots.entries('sidebar.right.tab.document')).toEqual([])
  expect(locale.bind('sidebarVideo')('title')).toBe('title')
})
