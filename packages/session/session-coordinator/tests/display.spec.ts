/** Main cards derive receipt facts without enabling worker execution or arbitrary Skills. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import Skills from '@deepseek-ai/dsh-skill'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CoordinationTaskId } from '../src/types.ts'
import { latest } from '../src/ledger.ts'
import { setup, textResponse } from './fixture.ts'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function fixture(options: { limit?: number; readChars?: number; script?: Parameters<typeof setup>[1] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-display-'))
  const test = await setup(root, options.script ?? Array.from({ length: 30 }, () => textResponse('ack')), undefined,
    { ...(options.limit === undefined ? {} : { searchLimit: options.limit }),
      ...(options.readChars === undefined ? {} : { readChars: options.readChars }) })
  onTestFinished(async () => { await test.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const main = await test.makeAgent('display-main', 'main-session')
  const input = (): void => { main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Show the actual task report.' }] })) }
  input()
  await main.whenIdle()
  const invoke = (name: string, args: Record<string, unknown> = {}, agent = main) => executeToolFixture(test.ctx, {
    agent, name, arguments: args, callId: ToolCallId('display-call'), signal: new AbortController().signal,
  })
  return { ...test, main, invoke, input }
}

const request = { key: 'display-goal', title: 'Deliver episode two', instructions: 'Preserve episode three.', reason: 'Owner asked for the report.', cwd: '/worker' }

it('captures only Host receipt facts and native file declarations in the tool metadata', async () => {
  const test = await fixture()
  const task = await test.service.dispatch(test.main, request)
  const worker = test.ctx.agents.get(latest(task).sessionId)!
  await worker.whenIdle()
  worker.session.append('deliverables/presented', { turn: 1, callId: ToolCallId('present-real'), files: [{ path: '/worker/actual.md', description: 'Episode two' }] })
  await test.service.report(worker, task.id, 1, 'completed', 'Actual result written')
  const report = await test.service.displayReport(test.main, [task.id])
  expect(report).toMatchObject({ version: 1, owner: test.main.id, total: 1, truncated: false, tasks: [{
    id: task.id, title: request.title, revision: 1, sessionId: worker.id, cwd: '/worker', status: 'finishing',
    report: { outcome: 'completed', summary: 'Actual result written', files: [{ path: '/worker/actual.md', description: 'Episode two' }] },
  }] })
  const result = await test.invoke('coordinator_show_report', { task_ids: [task.id], status: 'completed', files: ['/fake.md'] })
  expect(result.isError).not.toBe(true)
  expect(result.meta).toEqual({ museCoordinationReport: report })
  expect(JSON.stringify(result)).not.toContain('/fake.md')
  expect(test.ctx.tools.get('coordinator_report', test.main)).toBeUndefined()
})

it('rejects foreign, missing, duplicate and excessive task references through actual execution', async () => {
  const test = await fixture()
  const task = await test.service.dispatch(test.main, request)
  const other = await test.makeAgent('other-main', 'main-session')
  other.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read a report.' }] }))
  await other.whenIdle()
  expect((await test.invoke('coordinator_show_report', { task_ids: [task.id] }, other)).isError).toBe(true)
  const missing = brandString<CoordinationTaskId>('missing-task')
  await expect(test.service.displayReport(test.main, [missing])).rejects.toThrow('does not belong')
  expect((await test.invoke('coordinator_show_report', { task_ids: [task.id, task.id] })).isError).toBe(true)
  expect((await test.invoke('coordinator_show_report', { task_ids: Array.from({ length: 31 }, (_, i) => `task-${i}`) })).isError).toBe(true)
  const worker = await test.makeAgent('worker-reader')
  await expect(test.service.displayReport(worker, [])).rejects.toThrow('main-session')
})

it('uses the configured report bound and marks a recent-task report as incomplete', async () => {
  const test = await fixture({ limit: 1 })
  await test.service.dispatch(test.main, request)
  await test.service.dispatch(test.main, { ...request, key: 'second-goal' })
  const report = await test.service.displayReport(test.main)
  expect(report.tasks).toHaveLength(1)
  expect(report.total).toBe(2)
  expect(report.truncated).toBe(true)
  const emptySelection = await test.service.displayReport(test.main, [])
  expect(emptySelection).toMatchObject({ total: 2, truncated: true })
  expect(emptySelection.tasks.map(task => task.id)).toEqual(report.tasks.map(task => task.id))
})

it('keeps generic cards visible while blocking inherited and late business tools and arbitrary Skill loading', async () => {
  const test = await fixture()
  for (const name of ['show_view', 'visualize', 'bash', 'read', 'write', 'skill']) {
    test.ctx.tools.register(defineTool({ name, description: name, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] }, execute: async () => 'displayed' }))
  }
  for (const name of ['show_view', 'visualize', 'coordinator_show_report', 'coordinator_display_skill']) {
    expect(test.ctx.tools.schemas(test.main).map(schema => schema.name)).toContain(name)
  }
  expect((await test.invoke('show_view')).isError).not.toBe(true)
  expect((await test.invoke('visualize')).isError).not.toBe(true)
  for (const name of ['bash', 'read', 'write', 'skill']) expect((await test.invoke(name, { name: 'visualize' })).isError).toBe(true)
  await test.ctx.plugin(Skills)
  test.ctx.skills.register({ name: 'visualize', source: 'runtime', description: 'Display', content: 'DISPLAY INSTRUCTIONS' })
  test.ctx.skills.register({ name: 'business', source: 'runtime', description: 'Execution', content: 'SECRET BUSINESS INSTRUCTIONS' })
  const result = await test.invoke('coordinator_display_skill', { name: 'business' })
  expect(result.content).toEqual([{ type: 'text', text: 'DISPLAY INSTRUCTIONS' }])
})

it('budgets complete task receipts across model content and metadata without cutting file or summary fields', async () => {
  const test = await fixture({ readChars: 1000 })
  await test.service.dispatch(test.main, request)
  await test.service.dispatch(test.main, { ...request, key: 'second-goal' })
  const result = await test.service.displayReport(test.main)
  expect(result).toMatchObject({ total: 2, truncated: true })
  expect(result.tasks).toHaveLength(1)
  expect(JSON.stringify(result).length + JSON.stringify({ museCoordinationReport: result }).length).toBeLessThanOrEqual(1000)
  const huge = await test.service.dispatch(test.main, { ...request, key: 'oversized-goal', title: 'x'.repeat(1000) })
  const failure = await test.invoke('coordinator_show_report', { task_ids: [huge.id] })
  expect(failure.isError).toBe(true)
  expect(failure.error?.info).toMatchObject({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
})

it('fails the fixed display loader explicitly when the native Skill is absent or model-disabled', async () => {
  const test = await fixture()
  expect((await test.invoke('coordinator_display_skill')).isError).toBe(true)
  await test.ctx.plugin(Skills)
  expect((await test.invoke('coordinator_display_skill')).isError).toBe(true)
  test.ctx.skills.register({ name: 'visualize', source: 'runtime', description: 'Display', content: 'Hidden',
    invocation: { modelInvocable: false, userInvocable: true } })
  expect((await test.invoke('coordinator_display_skill')).isError).toBe(true)
})

it('persists a structured report in a native keyless turn for replay after restart', async () => {
  const test = await fixture({ script: [toolCallResponse('report-card', 'coordinator_show_report', {}), textResponse('No tasks yet.')] })
  const log = await test.ctx.sessionQuery.readSession(test.main.id)
  const result = log.events.find(event => event.type === 'tool/result')
  expect(result?.type === 'tool/result' && result.data.meta).toEqual({ museCoordinationReport: {
    version: 1, owner: test.main.id, tasks: [], total: 0, truncated: false,
  } })
  expect(JSON.stringify(test.adapter.requests)).toContain('coordinator_show_report')
  expect(JSON.stringify(test.adapter.requests)).toContain('关键进展')
})
