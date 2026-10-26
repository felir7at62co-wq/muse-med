import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import * as plugin from '../src/index.ts'

it.each(['https://muse.example/feedback', 'http://localhost:19488/feedback'])(
  'publishes the validated feedback URL and releases it with the Host plugin (%s)', async (feedbackUrl) => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const fiber = ctx.plugin(plugin, { feedbackUrl })
    await fiber.await()
    const table: IndexInjection[] = []
    ctx.emit('webserver/index-inject', table)
    expect(table).toEqual([{
      kind: 'global', name: '__MUSE_FEEDBACK_CONFIG__', value: { feedbackUrl },
    }])
    await fiber.dispose()
    const after: IndexInjection[] = []
    ctx.emit('webserver/index-inject', after)
    expect(after).toEqual([])
  },
)
