#!/usr/bin/env node
/** Real app/Loader test: only model responses are synthetic; all tools are local. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expandAssistantStream, LlmAdapter, resolveRetryPolicy, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TOOL_ARGUMENT_LOOP } from '@deepseek-ai/dsh-argument-loop'

const [configPath, scenario] = process.argv.slice(2)
if (!configPath) throw new Error('expected real Loader config path')
if (!['first', 'prior', 'recover', 'prior-recover', 'exhausted'].includes(scenario ?? '')) throw new Error('expected guard scenario')
const priorWork = scenario === 'prior' || scenario === 'prior-recover'
const recovery = scenario === 'recover' || scenario === 'prior-recover' || scenario === 'exhausted'
const exhausted = scenario === 'exhausted'
const loopRequest = priorWork ? 2 : 1
const uninstall = installFailLoud('argument-loop-loader-test')
let ctx: Context | undefined
let successfulWrites = 0
let simulatedPaidCalls = 0
let failedResponseCalls = 0
let recoveredWrites = 0

/** Field spelling/count emulate the incident; this is not an exact personal log replay. */
class SyntheticIncidentAdapter extends LlmAdapter {
  requests = 0
  exits = 0
  repeatedMembersProduced = 0
  private readonly retryPolicy = resolveRetryPolicy({
    mode: 'always',
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'synthetic provider retry policy')

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    try {
      if (priorWork && this.requests === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('prior-write'), name: 'write_checkpoint', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (recovery && !exhausted && this.requests === loopRequest + 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('recovered-write'), name: 'write_recovered', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (recovery && !exhausted && this.requests === loopRequest + 2) {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Completed from retained work after one bounded response recovery.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (this.requests > loopRequest + (exhausted ? 1 : 0)) throw new Error('unexpected model request: recovery budget exceeded')
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Useful partial work remains in the raw attempt.' } }
      // Even this complete call in the failing response must never dispatch.
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('same-response-write'), name: 'forbidden_write', arguments: '{}' } }
      yield { type: 'block-start', index: 2, blockType: 'tool-call' }
      for (let i = 0; i < 18_000; i++) {
        this.repeatedMembersProduced++
        yield {
          type: 'tool-call-delta', index: 2, id: ToolCallId('looping-tasks'), name: 'tasks',
          argumentsDelta: `${i === 0 ? '{' : ','}"page_num":1`,
        }
      }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    } finally {
      this.exits++
    }
  }
}

try {
  const museDefaults = loadOverlayPatches('argument-loop-loader-test', fileURLToPath(new URL(
    '../../../../../apps/desktop-host/config/defaults.cordis.patch.yml', import.meta.url,
  )))
  const policy = museDefaults.filter(patch => patch.insert?.some(row => ['tool-argument-loop', 'agent-output-continuation'].includes(row.id ?? '')))
  const guardRows = policy.flatMap(patch => patch.insert ?? []).filter(row => row.id === 'tool-argument-loop')
  assert.equal(guardRows.length, 1)
  assert.equal(guardRows[0]?.name, '@deepseek-ai/dsh-argument-loop')
  assert.deepEqual(guardRows[0].config, { repeatedPropertyLimit: 64, recoveryAttempts: 1 })
  // Legacy terminal cases explicitly disable the Muse opt-in.
  guardRows[0].config = { repeatedPropertyLimit: 64, recoveryAttempts: recovery ? 1 : 0 }
  ctx = await boot('argument-loop-loader-test', configPath, policy)
  const loaded = ctx
  const adapter = new SyntheticIncidentAdapter()
  loaded.llm.registerAdapter(['synthetic'], adapter)
  loaded.tools.register(defineTool({
    name: 'write_checkpoint', description: 'Write one already approved local checkpoint and simulated cost ledger.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => {
      successfulWrites++
      simulatedPaidCalls++
      await writeFile(join(process.cwd(), 'completed-work.txt'), 'prior approved work\n', { flag: 'wx' })
      await writeFile(join(process.cwd(), 'simulated-paid-ledger.json'), JSON.stringify({ calls: simulatedPaidCalls }) + '\n', { flag: 'wx' })
      return 'checkpoint retained'
    },
  }))
  loaded.tools.register(defineTool({
    name: 'write_recovered', description: 'Write one local recovered result.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => {
      recoveredWrites++
      await writeFile(join(process.cwd(), 'recovered-work.txt'), 'recovered response result\n', { flag: 'wx' })
      return 'recovered result retained'
    },
  }))
  for (const name of ['tasks', 'forbidden_write']) {
    loaded.tools.register(defineTool({
      name, description: 'A local counter that must not execute from the rejected response.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => {
        failedResponseCalls++
        return 'unexpected dispatch'
      },
    }))
  }
  const agent = await loaded.agentLoop.create(SessionId('argument-loop-loader'), { provider: 'synthetic', model: 'synthetic' })
  const settled = Promise.withResolvers<null>()
  const blocked = Promise.withResolvers<null>()
  loaded.on('goal/changed', ({ change }) => { if (change.operation === 'block') blocked.resolve(null) })
  loaded.on('session/event', (session, event) => {
    if (session !== agent.session || event.type !== 'turn/end') return
    if (event.data.reason.kind === 'error') assert.equal(event.data.reason.error.code, TOOL_ARGUMENT_LOOP)
    settled.resolve(null)
  })
  loaded.goals.create(agent, { objective: 'Write approved local work, then inspect the tasks list.', maxGoalRounds: 1 })
  await settled.promise
  await agent.whenIdle()
  if (recovery && !exhausted) await blocked.promise
  const events = agent.session.snapshotEvents()
  const expectedRequests = loopRequest + (recovery ? exhausted ? 1 : 2 : 0)
  assert.equal(adapter.requests, expectedRequests, 'only the configured bounded response recovery is allowed')
  assert.equal(adapter.repeatedMembersProduced, exhausted ? 128 : 64, 'stop before the synthetic 18,000-member response is emitted')
  assert.equal(adapter.exits, adapter.requests, 'all upstream iterators have returned and settled')
  assert.equal(successfulWrites, priorWork ? 1 : 0)
  assert.equal(simulatedPaidCalls, priorWork ? 1 : 0)
  assert.equal(failedResponseCalls, 0)
  assert.equal(recoveredWrites, recovery && !exhausted ? 1 : 0)
  if (priorWork) {
    assert.equal(await readFile(join(process.cwd(), 'completed-work.txt'), 'utf8'), 'prior approved work\n')
    assert.deepEqual(JSON.parse(await readFile(join(process.cwd(), 'simulated-paid-ledger.json'), 'utf8')), { calls: 1 })
  } else {
    await assert.rejects(readFile(join(process.cwd(), 'completed-work.txt')), { code: 'ENOENT' })
    await assert.rejects(readFile(join(process.cwd(), 'simulated-paid-ledger.json')), { code: 'ENOENT' })
  }
  assert.equal(events.filter(event => event.type === 'llm/retry').length, 0)
  assert.equal(events.filter(event => event.type === 'tool/call').length, (priorWork ? 1 : 0) + recoveredWrites)
  assert.equal(events.filter(event => event.type === 'tool/result').length, (priorWork ? 1 : 0) + recoveredWrites)
  const attempts = events.filter(event => event.type === 'assistant/attempt')
  assert.equal(attempts.length, exhausted ? 2 : 1)
  const attempt = attempts[0]
  assert.ok(attempt)
  const raw = expandAssistantStream(attempt.data.stream).map(record => record.chunk)
  assert.ok(raw.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text.includes('Useful partial work')))
  assert.equal(raw.filter(chunk => chunk.type === 'tool-call-delta').length, 64)
  assert.ok(raw.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.name === 'forbidden_write'))
  assert.equal(raw.some(chunk => chunk.type === 'finish'), recovery)
  const goal = loaded.goals.get(agent)
  assert.ok(goal)
  assert.equal(goal?.phase, recovery && !exhausted ? 'blocked' : 'active')
  assert.equal(goal.activation, 'disarmed')
  assert.equal(goal.roundsStarted, 1)
  await writeFile(join(process.cwd(), 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n', { flag: 'wx' })
  await loaded.fiber.dispose()
  ctx = undefined
  const result = {
    passed: true, scenario, fixture: 'synthetic incident class, not exact EP23 replay',
    requests: adapter.requests, repeated_members_produced: adapter.repeatedMembersProduced,
    upstream_exits: adapter.exits, successful_writes: successfulWrites, simulated_paid_calls: simulatedPaidCalls,
    failed_response_tool_calls: failedResponseCalls, recovered_writes: recoveredWrites, retry_events: 0,
    attempt_deltas_retained: 64, raw_attempts: attempts.length, goal_phase: goal.phase,
    goal_activation: goal.activation, goal_rounds_started: goal.roundsStarted,
    plugin_disposal_completed: true,
    actual_muse_defaults_loaded: true,
  }
  await writeFile(join(process.cwd(), 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await ctx?.fiber.dispose()
  uninstall()
}
