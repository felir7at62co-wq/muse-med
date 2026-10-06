import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { realpathSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { installDesktopDouyinBrowser } from '../src/douyin-browser.ts'

it.each([
  ['PREPARED', 'UNSUPPORTED_MEDIA_ASSOCIATION'],
  ['PREPARED', 'DOWNLOAD_HTTP_403'],
  ['LOGIN_OR_VERIFICATION_REQUIRED', 'UNSUPPORTED_MEDIA_ASSOCIATION'],
  ['DOWNLOAD_HTTP_403', 'UNSUPPORTED_MEDIA_ASSOCIATION'],
])(
  'starts or rejects the target-bound download after %s and preserves %s',
  async (preparedCode, downloadCode) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('native-approval-fixture'), {
      meta: { cwd: realpathSync(process.cwd()) },
    })
    session.append('turn/start', { turn: 1 })
    const operations: string[] = []
    const limits: number[] = []
    const connected = Object.getOwnPropertyDescriptor(process, 'connected')
    const send = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'connected', { value: true, configurable: true })
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: (
        message: { action: string; requestId: string; taskId: string; maxDownloadBytes: number },
        callback: (error: Error | null) => void,
      ) => {
        operations.push(message.action)
        limits.push(message.maxDownloadBytes)
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
      const result = await ctx.douyinBrowser.download(
        { id: session.id, session } as never,
        'https://v.douyin.com/zz584KwAVaA/',
        new AbortController().signal,
        512 * 1024 ** 2,
      )
      expect(result).toMatchObject({
        status: 'blocked',
        code: preparedCode === 'PREPARED' ? downloadCode : preparedCode,
      })
      expect(operations).toEqual(
        preparedCode === 'PREPARED' ? ['prepare', 'download', 'release'] : ['prepare', 'release'],
      )
      expect(limits).toEqual(operations.map(() => 512 * 1024 ** 2))
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
