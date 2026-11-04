import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { DouyinDesktopRequest } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { realpathSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { installDesktopDouyinBrowser } from '../src/douyin-browser.ts'

it.each([
  ['PREPARED', 'UNSUPPORTED_MEDIA_ASSOCIATION'],
  ['PREPARED', 'DOWNLOAD_HTTP_403'],
  ['LOGIN_OR_VERIFICATION_REQUIRED', 'UNSUPPORTED_MEDIA_ASSOCIATION'],
  ['DOWNLOAD_HTTP_403', 'UNSUPPORTED_MEDIA_ASSOCIATION'],
].flatMap(([prepared, download]) => [[prepared, download, false], [prepared, download, true]] as const))(
  'starts or rejects the target-bound download after %s and preserves %s',
  async (preparedCode, downloadCode, background) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('native-approval-fixture'), {
      meta: { cwd: realpathSync(process.cwd()) },
    })
    session.append('turn/start', { turn: 1 })
    const operations: string[] = []
    const limits: number[] = []
    const budgets: number[] = []
    const backgrounds: Array<true | undefined> = []
    const connected = Object.getOwnPropertyDescriptor(process, 'connected')
    const send = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'connected', { value: true, configurable: true })
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: (
        message: {
          action: string
          requestId: string
          taskId: string
          maxDownloadBytes: number
          nativeTimeoutMs: number
          background?: true
        },
        callback: (error: Error | null) => void,
      ) => {
        operations.push(message.action)
        limits.push(message.maxDownloadBytes)
        budgets.push(message.nativeTimeoutMs)
        backgrounds.push(message.background)
        queueMicrotask(() => {
          if (message.action === 'download')
            EventEmitter.prototype.emit.call(process, 'message', {
              type: 'douyin-browser-revoked',
              taskId: message.taskId,
              code: downloadCode,
            })
          EventEmitter.prototype.emit.call(process, 'message', {
            type: 'douyin-browser-result',
            requestId: message.requestId,
            code:
              message.action === 'prepare'
                ? preparedCode
                : message.action === 'download'
                  ? downloadCode
                  : 'RELEASED',
            targetVideoId: '7692443246022167851',
          })
        })
        callback(null)
      },
    })
    try {
      installDesktopDouyinBrowser(ctx)
      expect(ctx.douyinBrowser.version).toBe(4)
      expect(ctx.douyinBrowser.supportsBackgroundDownload).toBe(true)
      const result = await ctx.douyinBrowser.download(
        { id: session.id, session, ctx } as never,
        'https://v.douyin.com/zz584KwAVaA/',
        new AbortController().signal,
        512 * 1024 ** 2,
        1_800_000,
        background ? { background: true } : undefined,
      )
      expect(result).toMatchObject({
        status: 'blocked',
        code: preparedCode === 'PREPARED' ? downloadCode : preparedCode,
      })
      expect(operations).toEqual(
        preparedCode === 'PREPARED' ? ['prepare', 'download', 'release'] : ['prepare', 'release'],
      )
      expect(backgrounds).toEqual(operations.map(() => background ? true : undefined))
      expect(limits).toEqual(operations.map(() => 512 * 1024 ** 2))
      expect(budgets).toEqual(operations.map(() => 1_800_000))
      expect(
        session
          .snapshotEvents()
          .filter(event => event.type.startsWith('approval/'))
          .map(event => event.type),
      ).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      if (connected) Object.defineProperty(process, 'connected', connected)
      else Reflect.deleteProperty(process, 'connected')
      if (send) Object.defineProperty(process, 'send', send)
      else Reflect.deleteProperty(process, 'send')
    }
  },
)

it.each(['late-result', 'expiry', 'caller-cancel', 'owner-dispose', 'owner-scope'] as const)(
  'native transfer passes the former 130-second IPC deadline and settles: %s', async (mode) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('native-long-transfer'), { meta: { cwd: realpathSync(process.cwd()) } })
    const connected = Object.getOwnPropertyDescriptor(process, 'connected')
    const send = Object.getOwnPropertyDescriptor(process, 'send')
    const cancellation = new AbortController()
    const ownerScope = createScope(ctx, {})
    const agent = { id: session.id, session, ctx: ownerScope.ctx } as never
    let download: DouyinDesktopRequest | undefined
    let operation: Promise<object> | undefined
    const reply = (request: DouyinDesktopRequest, code: string): void => {
      EventEmitter.prototype.emit.call(process, 'message', {
        type: 'douyin-browser-result', requestId: request.requestId, code, targetVideoId: '7692443246022167851',
      })
    }
    Object.defineProperty(process, 'connected', { value: true, configurable: true })
    Object.defineProperty(process, 'send', { configurable: true,
      value: (request: DouyinDesktopRequest, callback: (error: Error | null) => void) => {
        queueMicrotask(() => {
          if (request.action === 'download') download = request
          else {
            if (request.action === 'release' && download !== undefined) {
              reply(download, 'CANCELLED')
              download = undefined
            }
            reply(request, request.action === 'prepare' ? 'PREPARED' : 'RELEASED')
          }
        })
        callback(null)
      },
    })
    vi.useFakeTimers()
    try {
      installDesktopDouyinBrowser(ctx)
      operation = ctx.douyinBrowser.download(agent,
        'https://www.douyin.com/video/7692443246022167851', cancellation.signal, 1024, 300_000, { background: true })
      let settled = false
      void operation.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(80_000)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(50_001)
      expect(download).toBeDefined()
      expect(settled).toBe(false)
      if (download === undefined) throw new Error('Missing long native transfer')
      expect(download.nativeTimeoutMs).toBe(300_000)
      if (mode === 'late-result') {
        await vi.advanceTimersByTimeAsync(249_999)
        expect(settled).toBe(false)
        reply(download, 'UNSUPPORTED_MEDIA_ASSOCIATION')
        download = undefined
      } else if (mode === 'expiry') {
        await vi.advanceTimersByTimeAsync(299_998)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
      }
      else if (mode === 'owner-dispose') await ctx.parallel('agent/disposed', { agent })
      else if (mode === 'owner-scope') await ownerScope.dispose()
      else cancellation.abort()
      expect(await operation).toMatchObject({ code: mode === 'late-result' ? 'UNSUPPORTED_MEDIA_ASSOCIATION'
        : mode === 'expiry' ? 'TRANSPORT_TIMEOUT' : (mode === 'owner-dispose' || mode === 'owner-scope') ? 'OWNER_LOST' : 'CANCELLED' })
    } finally {
      cancellation.abort()
      await vi.advanceTimersByTimeAsync(0)
      await operation
      await ownerScope.dispose()
      await ctx.fiber.dispose()
      vi.useRealTimers()
      if (connected) Object.defineProperty(process, 'connected', connected); else Reflect.deleteProperty(process, 'connected')
      if (send) Object.defineProperty(process, 'send', send); else Reflect.deleteProperty(process, 'send')
    }
  },
)
