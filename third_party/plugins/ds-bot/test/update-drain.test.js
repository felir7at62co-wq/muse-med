import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { runBrowserUpdateDrainProbe } from './update-drain-fixture.mjs'

test('legacy Desktop cancels a real HTTP Bot poll before update lock and resumes the same window', async () => {
  const ctx = new Context()
  ctx.provide('agents', { list: () => [] })
  ctx.provide('jobs', { list: () => [] })
  try {
    assert.deepEqual(await runBrowserUpdateDrainProbe(ctx), {
      interruptedPollCancelled: true, lockCompletedBeforeDeadline: true, activeTasksRetained: false,
      resumedPollCount: 1, resumedReadCompleted: true, pendingPolls: 0, pendingHandlers: 0,
    })
  } finally { await ctx.fiber.dispose() }
})

test('cancelling the legacy HTTP poll preserves active task warnings', async () => {
  const ctx = new Context()
  const agents = [{ status: 'running', inbox: { nextTurn: [], nextStep: [] } }]
  ctx.provide('agents', { list: () => agents })
  ctx.provide('jobs', { list: () => [] })
  try {
    const result = await runBrowserUpdateDrainProbe(ctx, { expectedActiveTasks: true })
    assert.equal(result.activeTasksRetained, true)
    assert.equal(agents[0].status, 'running')
  } finally { await ctx.fiber.dispose() }
})
