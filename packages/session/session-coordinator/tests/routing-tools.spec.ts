/** Main routing tools forward optional routing fields, and the routing preset keeps its policy when mounted outside an Agent. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { Config } from '../src/index.ts'
import { latest } from '../src/ledger.ts'
import * as Main from '../src/main.ts'
import type { Assignment, CoordinationTaskId } from '../src/types.ts'
import { setup, textResponse } from './fixture.ts'

async function fixture(config: Config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-routing-tools-'))
  const test = await setup(root, Array.from({ length: 40 }, () => textResponse('ack')), undefined, config)
  onTestFinished(async () => { await test.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const invoke = (name: string, args: Record<string, unknown>, agent?: Agent) => executeToolFixture(test.ctx, {
    ...(agent === undefined ? {} : { agent }), name, arguments: args, callId: ToolCallId(`routing-${name}`), signal: new AbortController().signal,
  })
  const ask = async (main: Agent, text: string): Promise<void> => {
    main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await main.whenIdle()
  }
  const settled = async (main: Agent, id: CoordinationTaskId, match: (attempt: Assignment) => boolean): Promise<Assignment> => {
    const abort = new AbortController()
    try {
      for await (const tasks of test.service.watch(main.id, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]))) {
        const task = tasks.find(item => item.id === id && match(latest(item)))
        if (task !== undefined) return latest(task)
      }
      throw new Error(`Task ${id} did not settle as expected`)
    } finally { abort.abort() }
  }
  return { ...test, invoke, ask, settled }
}

function row(result: ToolExecutionResult): Record<string, unknown> {
  const first = result.content[0]
  if (result.isError || first?.type !== 'text') throw new Error(`Routing tool failed: ${JSON.stringify(result.content)}`)
  return JSON.parse(first.text) as Record<string, unknown>
}

it('continues a stopped task in the idle worker it names, then asks that worker to reconcile its unreported result', async () => {
  const test = await fixture()
  const main = await test.makeAgent('routing-main', 'main-session')
  await test.ask(main, 'Revise episode two.')
  const first = row(await test.invoke('coordinator_dispatch', { request_key: 'episode-two', title: 'Revise episode two',
    instructions: 'Revise episode two only.', reason: 'Owner asked for a revision.', cwd: '/worker' }, main))
  const taskId = brandString<CoordinationTaskId>(String(first.id))
  const workerId = String(first.sessionId)
  await test.settled(main, taskId, attempt => attempt.status === 'needs-report')

  const stopped = row(await test.invoke('coordinator_stop', { task_id: taskId, revision: 1 }, main))
  expect(stopped).toMatchObject({ id: taskId, revision: 1, sessionId: workerId })
  await test.settled(main, taskId, attempt => attempt.status === 'stopped')

  const sessions = row(await test.invoke('coordinator_sessions', { query: '' }, main)) as { sessions: { sessionId: string }[] }
  expect(sessions.sessions.map(session => session.sessionId)).toContain(workerId)
  expect(sessions.sessions.map(session => session.sessionId)).not.toContain(main.id)

  await test.ask(main, 'Keep the same worker and finish the revision.')
  const continued = row(await test.invoke('coordinator_dispatch', { request_key: 'episode-two-continued', title: 'Revise episode two',
    instructions: 'Finish the revision.', reason: 'Owner asked to continue.', session_id: workerId, task_id: taskId, expected_revision: 1 }, main))
  expect(continued).toMatchObject({ id: taskId, revision: 2, sessionId: workerId, cwd: '/worker' })
  await test.settled(main, taskId, attempt => attempt.revision === 2 && attempt.status === 'needs-report')

  const check = { request_key: 'check-episode-two', task_id: taskId, expected_revision: 2,
    instructions: 'Check the existing revision and report.', reason: 'The worker did not report.' }
  const stale = await test.invoke('coordinator_reconcile', { ...check, expected_worker_seq: 0 }, main)
  expect(stale.isError).toBe(true)
  expect(stale.error?.info).toMatchObject({ code: 'INVALID_ARGS' })
  const reconciled = row(await test.invoke('coordinator_reconcile', check, main))
  expect(reconciled).toMatchObject({ id: taskId, revision: 3, sessionId: workerId, cwd: '/worker' })
  await test.settled(main, taskId, attempt => attempt.revision === 3 && attempt.notifiedStatus === 'needs-report')
  await main.whenIdle()

  const definition = test.ctx.tools.get('coordinator_reconcile', main)
  expect(definition?.presentCall?.(check)).toEqual({ card: 'generic', title: 'Task reconciliation', kind: 'edit' })
  const content = [{ type: 'text' as const, text: JSON.stringify(reconciled) }]
  expect(definition?.presentResult?.(check, { content, isError: false })).toEqual({ card: 'generic', title: 'Task reconciliation', content, kind: 'edit' })
})

it('restricts Agents created before and after a non-Agent mount and releases them when that mount unloads', async () => {
  const test = await fixture({ unattended: true })
  for (const name of ['bash', 'ask_user_question']) {
    test.ctx.tools.register(defineTool({ name, description: name, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] }, execute: async () => `${name} ran` }))
  }
  const before = await test.makeAgent('before-routing-mount')
  const mount = await test.ctx.plugin(Main)
  const after = await test.makeAgent('after-routing-mount')
  for (const agent of [before, after]) {
    const visible = test.ctx.tools.schemas(agent).map(schema => schema.name)
    expect(visible).toContain('coordinator_tasks')
    expect(visible).not.toContain('bash')
    expect(visible).not.toContain('ask_user_question')
    expect((await test.invoke('bash', {}, agent)).isError).toBe(true)
    expect((await test.invoke('ask_user_question', {}, agent)).isError).toBe(true)
  }
  const detached = await test.invoke('coordinator_tasks', {})
  expect(detached.isError).toBe(true)
  expect(JSON.stringify(detached.content)).toContain('A live Main Session is required')
  const detachedReport = await test.invoke('coordinator_show_report', {})
  expect(detachedReport.isError).toBe(true)
  expect(JSON.stringify(detachedReport.content)).toContain('Display requires the live Main Session')

  await mount.dispose()
  const released = test.ctx.tools.schemas(after).map(schema => schema.name)
  expect(released).toEqual(expect.arrayContaining(['bash', 'ask_user_question']))
  expect(released).not.toContain('coordinator_tasks')
  expect((await test.invoke('bash', {}, after)).isError).toBe(false)
})
