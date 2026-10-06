import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import * as plugin from '../src/index.ts'

it('publishes the validated public feedback URL for each page and releases it with the Host plugin', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const fiber = ctx.plugin(plugin, { feedbackUrl: 'https://muse.example/feedback' })
  await fiber.await()
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table)
  expect(table).toEqual([{
    kind: 'global', name: '__MUSE_FEEDBACK_CONFIG__', value: { feedbackUrl: 'https://muse.example/feedback' },
  }])
  await fiber.dispose()
  const after: IndexInjection[] = []
  ctx.emit('webserver/index-inject', after)
  expect(after).toEqual([])
})
