import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { realpathSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { installDesktopDouyinBrowser } from '../src/douyin-browser.ts'

it.each(['PREPARED', 'LOGIN_OR_VERIFICATION_REQUIRED'])(
  'starts the target-bound download without an additional prompt after %s',
  async (preparedCode) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('native-approval-fixture'), {
      meta: { cwd: realpathSync(process.cwd()) },
    })
    session.append('turn/start', { turn: 1 })
    const operations: string[] = []
    const connected = Object.getOwnPropertyDescriptor(process, 'connected')
    const send = Object.getOwnPropertyDescriptor(process, 'send')
    Object.defineProperty(process, 'connected', { value: true, configurable: true })
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: (message: Record<string, string>, callback: (error: Error | null) => void) => {
        operations.push(message.action ?? '')
        queueMicrotask(() => {
          if (message.action === 'download')
            EventEmitter.prototype.emit.call(process, 'message', {
              type: 'douyin-browser-revoked',
              taskId: message.taskId,
              code: 'UNSUPPORTED_MEDIA_ASSOCIATION',
            })
          EventEmitter.prototype.emit.call(process, 'message', {
            type: 'douyin-browser-result',
            requestId: message.requestId,
            code:
              message.action === 'prepare'
                ? preparedCode
                : message.action === 'download'
                  ? 'UNSUPPORTED_MEDIA_ASSOCIATION'
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
      )
      expect(result).toMatchObject({
        status: 'blocked',
        code: preparedCode === 'PREPARED' ? 'UNSUPPORTED_MEDIA_ASSOCIATION' : preparedCode,
      })
      expect(operations).toEqual(
        preparedCode === 'PREPARED' ? ['prepare', 'download', 'release'] : ['prepare', 'release'],
      )
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
