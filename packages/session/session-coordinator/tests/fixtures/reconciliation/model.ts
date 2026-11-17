/** Scripted external model and direct human input for the profile reconciliation smoke. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { CoordinationTask } from '../../../src/types.ts'
import type {} from '../../../src/index.ts'

/** Test-only Loader contribution. */
export const name = 'reconciliation-fixture'
/** The subject uses the actual controller, preset, loop, attachment and storage providers. */
export const inject = ['llm', 'agents', 'agentPresets', 'sessionCoordinator', 'attachments', 'tools', 'sessions', 'sessionQuery']

declare module '@deepseek-ai/cordis' {
  interface Context { reconciliationFixture: true }
}

function text(value: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function call(name: string, args: object, step: number): StreamChunk[] {
  const id = ToolCallId(`fixture-${step}-${name}`)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function latest(task: CoordinationTask) {
  const attempt = task.attempts.at(-1)
  assert.ok(attempt)
  return attempt
}

class FixtureAdapter extends LlmAdapter {
  private ctx: Context
  private mainStep = 0
  private main: Agent | undefined
  private task: CoordinationTask | undefined
  private direct: UserMessage | undefined
  private originalModel: ReturnType<Agent['model']['current']>
  private originalDirectory: string | undefined
  private ordinaryToolDenied = false
  private proofWritten = false

  constructor(ctx: Context) { super(); this.ctx = ctx }

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, contextWindow: 1000000, defaultMaxTokens: 4096 }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const mainTools = options.tools?.some(tool => tool.name === 'coordinator_dispatch') === true
    const chunks = mainTools ? await this.mainResponse(options) : this.workerResponse(options)
    for (const chunk of chunks) yield chunk
  }

  private async waitTask(status: string, changedInput = false): Promise<CoordinationTask> {
    assert.ok(this.main)
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
    try {
      for await (const tasks of this.ctx.sessionCoordinator.watch(this.main.id, signal)) {
        const task = tasks.find(item => latest(item).status === status
          && latest(item).notifiedStatus === status
          && (!changedInput || latest(item).changedInputSeq !== undefined
            && latest(item).notifiedInputSeq === latest(item).changedInputSeq))
        if (task !== undefined) return task
      }
      throw new Error(`Task did not reach ${status}`)
    } finally { controller.abort() }
  }

  private workerResponse(options: GenerateOptions): StreamChunk[] {
    const last = options.messages.at(-1)
    if (last?.role === 'tool') return text('执行会话已处理回执。')
    const assignment = options.messages.findLast(message => message.role === 'user'
      && message.source?.kind === 'muse-coordination' && message.source.purpose === 'assignment')
    assert.ok(assignment?.role === 'user' && assignment.source?.kind === 'muse-coordination')
    const human = options.messages.findLast(message => message.role === 'user' && message.source?.kind === 'user')
    const changed = human?.role === 'user' && human.id === this.direct?.id
    if (assignment.source.revision > 1 || changed) {
      return call('coordinator_report', { task_id: assignment.source.taskId, revision: assignment.source.revision,
        outcome: 'completed', summary: assignment.source.revision > 1 ? '第二集与补充材料已核对；第三集未改动。' : '过期任务报告应被拒绝。' }, assignment.source.revision)
    }
    return text('执行结果保留在本会话，尚未提交结构化报告。')
  }

  private async mainResponse(options: GenerateOptions): Promise<StreamChunk[]> {
    const step = this.mainStep++
    if (step === 0) {
      this.main = this.ctx.agents.list().find(agent => this.ctx.agentPresets.composedPreset(agent.ctx) === 'main-session')
      assert.ok(this.main)
      assert.ok(options.tools?.some(tool => tool.name === 'coordinator_reconcile'))
      assert.ok(!options.tools?.some(tool => tool.name === 'bash'))
      return call('bash', { command: 'printf forbidden > should-not-exist.txt' }, step)
    }
    if (step === 1) {
      const denied = options.messages.findLast(message => message.role === 'tool')
      assert.ok(denied?.role === 'tool' && denied.isError)
      return call('coordinator_dispatch', { request_key: 'initial-assignment', title: '第二集精修',
        instructions: '保留原稿与候选稿。只处理第二集，第三集不要动。完成后汇报。', reason: '由普通执行会话完成精修' }, step)
    }
    if (step === 2) {
      this.task = await this.waitTask('needs-report')
      const worker = this.ctx.agents.get(latest(this.task).sessionId)
      assert.ok(worker)
      this.originalModel = worker.model.current()
      this.originalDirectory = worker.session.header.cwd
      const attachment = await this.ctx.attachments.saveFile({ data: new TextEncoder().encode('第二集补充批注：第三集不要动。'), name: 'review-notes.txt' })
      this.direct = createUserMessage({ source: { kind: 'user' }, content: [
        { type: 'text', text: '补充：第二集保持原人物关系，请结合附件核对。第三集不要动。' }, { type: 'file', attachment },
      ] })
      worker.followup(this.direct)
      await worker.whenIdle()
      this.task = await this.waitTask('needs-report', true)
      const history = await this.ctx.sessionQuery.readSession(worker.id)
      const through = history.events.at(-1)?.seq
      assert.ok(through !== undefined)
      const denied = await executeToolFixture(this.ctx, { agent: worker, name: 'coordinator_reconcile',
        arguments: { request_key: 'worker-cannot-reconcile', task_id: this.task.id, expected_revision: 1,
          expected_worker_seq: through, instructions: '核对已有结果。', reason: '验证执行会话不能接管主会话权限' },
        callId: ToolCallId('ordinary-reconcile-denied'), signal: new AbortController().signal })
      this.ordinaryToolDenied = denied.isError
      return call('coordinator_read', { session_id: worker.id, view: 'events', from_seq: 0 }, step)
    }
    if (step === 3) {
      assert.ok(this.task)
      const response = options.messages.findLast(message => message.role === 'tool')
      assert.ok(response?.role === 'tool' && !response.isError)
      const content = response.content.find(block => block.type === 'text')
      assert.ok(content?.type === 'text')
      const observed = JSON.parse(content.text) as { complete: boolean; nextSeq: number | null; events: { seq: number }[] }
      if (!observed.complete) {
        assert.ok(observed.nextSeq !== null)
        this.mainStep--
        return call('coordinator_read', { session_id: latest(this.task).sessionId, view: 'events', from_seq: observed.nextSeq }, observed.nextSeq)
      }
      const through = observed.events.at(-1)?.seq
      assert.ok(through !== undefined)
      return call('coordinator_reconcile', { request_key: 'reconcile-direct-human', task_id: this.task.id,
        expected_revision: 1, expected_worker_seq: through,
        instructions: '核对本会话已完成内容和最新用户补充，然后重新汇报。不得重跑下载、生成或其他付费提交。',
        reason: '用户直接补充了执行要求，需保留原输入并恢复汇报' }, step)
    }
    if (step === 4) {
      assert.ok(this.task)
      const response = options.messages.findLast(message => message.role === 'tool')
      assert.ok(response?.role === 'tool' && !response.isError)
      this.task = await this.waitTask('completed')
      return call('coordinator_show_report', { task_ids: [this.task.id] }, step)
    }
    if (!this.proofWritten) this.proofWritten = await this.recordProof()
    return text(this.proofWritten ? 'reconciliation verified：第二集核对完成，第三集保留，已在主会话汇报。'
      : '已收到阶段回执，继续接收任务完成回报。')
  }

  private async recordProof(): Promise<boolean> {
    assert.ok(this.main && this.task && this.direct)
    const current = latest(this.task)
    const worker = this.ctx.agents.get(current.sessionId)
    assert.ok(worker)
    await this.ctx.sessions.flush(worker.session)
    const history = await this.ctx.sessionQuery.readSession(worker.id)
    const human = history.events.filter(event => event.type === 'user/message' && event.data.id === this.direct?.id)
    const failedReport = history.events.find(event => event.type === 'tool/result'
      && event.data.message.isError && event.data.message.toolCallId === 'fixture-1-coordinator_report')
    const mainHistory = await this.ctx.sessionQuery.readSession(this.main.id)
    const notices = mainHistory.events.flatMap((event) => {
      if (event.type !== 'user/message' || event.data.source.kind !== 'muse-coordination'
        || event.data.source.purpose !== 'receipt') return []
      const block = event.data.content.find(part => part.type === 'text')
      assert.ok(block?.type === 'text')
      const receipt = JSON.parse(block.text) as { revision: number; status: string }
      return [{ revision: receipt.revision, status: receipt.status }]
    })
    if (!notices.some(notice => notice.revision === 2 && notice.status === 'completed')) return false
    const checks = {
      mainToolVisible: true, businessToolDenied: true, ordinaryToolDenied: this.ordinaryToolDenied,
      staleReportDenied: failedReport !== undefined,
      sameWorker: this.task.attempts.every(attempt => attempt.sessionId === worker.id),
      sameModel: JSON.stringify(worker.model.current()) === JSON.stringify(this.originalModel),
      sameDirectory: worker.session.header.cwd === this.originalDirectory,
      humanMessagePreserved: human.length === 1 && human[0]?.type === 'user/message'
        && JSON.stringify(human[0].data) === JSON.stringify(this.direct),
      attachmentPreserved: human[0]?.type === 'user/message' && human[0].data.content.some(block => block.type === 'file'),
      completedRevision: current.revision === 2 && current.status === 'completed' && current.report?.outcome === 'completed',
      mainReceivedCompletion: notices.some(notice => notice.revision === 2 && notice.status === 'completed'),
    }
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks))
    await writeFile(join(process.cwd(), 'reconciliation-result.json'), JSON.stringify({ taskId: this.task.id,
      workerId: worker.id, mainId: this.main.id, workerHumanId: this.direct.id, mainNotices: notices, checks }, null, 2) + '\n')
    return true
  }
}

/**
 * Install the scripted model without replacing any production Session or task implementation.
 * @param ctx - Profile Loader context, isolated by the subprocess smoke harness.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter(['reconciliation-fixture'], new FixtureAdapter(ctx)))
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.agentPreset === undefined && agent.session.header.origin !== 'subagent') {
      await ctx.agentPresets.select(agent, 'main-session')
    }
  })
  ctx.provide('reconciliationFixture', true)
}
