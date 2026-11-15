import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import * as plugin from '../src/index.ts'

/** Index rendering has an owner Peer; this listener publishes no Peer-specific data. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]

it.each(['https://muse.example/feedback', 'http://localhost:19488/feedback'])(
  'publishes the validated feedback URL and releases it with the Host plugin (%s)', async (feedbackUrl) => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const fiber = ctx.plugin(plugin, { feedbackUrl })
    await fiber.await()
    const table: IndexInjection[] = []
    ctx.emit('webserver/index-inject', table, PAGE_PEER)
    expect(table).toEqual([{
      kind: 'global', name: '__MUSE_FEEDBACK_CONFIG__', value: { feedbackUrl },
    }])
    await fiber.dispose()
    const after: IndexInjection[] = []
    ctx.emit('webserver/index-inject', after, PAGE_PEER)
    expect(after).toEqual([])
  },
)
