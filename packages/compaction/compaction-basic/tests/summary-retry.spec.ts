/** Transient summary failures retried under the summary route's own retry policy. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { AgentModel, type Agent } from '@deepseek-ai/dsh-agent'
import type { SummarizationInput, SummaryResult } from '../src/summarizer.ts'

const PROVIDER = 'summary-route'
const MODEL = 'summary-model'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

/** Fail with each queued terminal failure, then answer with one checkpoint. */
class FlakySummaryAdapter extends LlmAdapter {
  calls = 0
  readonly failures: LlmFailure[] = []
  onCall: (() => void) | undefined

  constructor(private readonly policy: ResolvedRetryPolicy) { super() }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.policy
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.onCall?.()
    const failure = this.failures.shift()
    if (failure !== undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `FAILED_ATTEMPT_${this.calls}` } }
      yield { type: 'finish', reason: { kind: 'error', failure } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `CHECKPOINT_ATTEMPT_${this.calls}` } }
    yield { type: 'usage', usage: { inputTokens: 100 + this.calls, outputTokens: 7 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function fastPolicy(config: RetryPolicyConfig): ResolvedRetryPolicy {
  return resolveRetryPolicy({ ...config, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, ...config.backoff } },
    'summary-retry fixture')
}

/** Expose the protected summarization hook without changing it. */
class ExposedEngine extends BasicCompactionEngine {
  run(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    return this.summarize(input, agent, signal)
  }
}

function conversation(): Session {
  const session = Session.create(SessionId('summary-retry'))
  for (let turn = 1; turn <= 3; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `episode request ${turn}: ${'scene notes '.repeat(80)}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', { stream: [], turn, step: 1, message: createMessage({
      role: 'assistant', content: [{ type: 'text', text: `episode answer ${turn}: ${'draft lines '.repeat(80)}` }],
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 4 })
  return session
}

function agentFor(session: Session): Agent {
  const unsupported = (): never => { throw new Error('summary-retry fixture does not drive an Agent lifecycle') }
  const options = { provider: PROVIDER, model: MODEL }
  return {
    id: session.id, session, options,
    model: new AgentModel(() => ({ lastUsed: null, pending: null }), session, options),
    get inbox() { return unsupported() },
    get status() { return unsupported() },
    get ctx() { return unsupported() },
    cancel: unsupported, whenIdle: unsupported, runMaintenance: unsupported,
    send: unsupported, followup: unsupported, steer: unsupported, inject: unsupported,
  }
}

/** The route policy is captured at registration, so each case chooses it up front. */
function fixture(policy: RetryPolicyConfig = { mode: 'normal', maxRetries: 3 }) {
  const ctx = new Context()
  contexts.push(ctx)
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const adapter = new FlakySummaryAdapter(fastPolicy(policy))
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  const engine = new ExposedEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 512 })
  const session = conversation()
  const input: SummarizationInput = { messages: session.deriveMessages() }
  return { ctx, adapter, registration, engine, session, agent: agentFor(session), input }
}

const failure = (code: string, providerRetryAfterMs?: number): LlmFailure => ({
  message: `${code} from summary gateway`, code,
  ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
})

describe('compaction summary retry', () => {
  it('returns the successful attempt after one transient failure', async () => {
    const { adapter, engine, agent, input } = fixture()
    adapter.failures.push(failure('SERVER'))
    const result = await engine.run(input, agent)
    expect(adapter.calls).toBe(2)
    expect(result).toMatchObject({
      summary: [{ type: 'text', text: 'CHECKPOINT_ATTEMPT_2' }],
      rawOutput: [{ type: 'text', text: 'CHECKPOINT_ATTEMPT_2' }],
      usage: { inputTokens: 102, outputTokens: 7 },
      llmStreamCall: true, provider: PROVIDER, model: MODEL,
    })
  })

  it('reports the last failure after the route retry count is exhausted', async () => {
    const { adapter, engine, agent, input } = fixture({ mode: 'normal', maxRetries: 2 })
    adapter.failures.push(failure('SERVER'), failure('TRANSPORT'), failure('SERVER'), failure('SERVER'))
    await expect(engine.run(input, agent)).rejects.toMatchObject({ code: 'SERVER' })
    expect(adapter.calls).toBe(3)
  })

  it('does not retry a code outside the route policy', async () => {
    const { adapter, engine, agent, input } = fixture()
    adapter.failures.push(failure('AUTH'))
    await expect(engine.run(input, agent)).rejects.toMatchObject({ code: 'AUTH' })
    expect(adapter.calls).toBe(1)
  })

  it('stops when the provider asks for a delay above the policy maximum', async () => {
    const { adapter, engine, agent, input } = fixture()
    adapter.failures.push(failure('RATE_LIMIT', 5_000))
    await expect(engine.run(input, agent)).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    expect(adapter.calls).toBe(1)
  })

  it('waits for a provider delay within the policy maximum', async () => {
    const { adapter, engine, agent, input } = fixture({ mode: 'normal', maxRetries: 1, backoff: { maxDelayMs: 1_000 } })
    adapter.failures.push(failure('RATE_LIMIT', 20))
    const started = performance.now()
    await expect(engine.run(input, agent)).resolves.toMatchObject({ rawOutput: [{ type: 'text', text: 'CHECKPOINT_ATTEMPT_2' }] })
    expect(performance.now() - started).toBeGreaterThanOrEqual(19)
    expect(adapter.calls).toBe(2)
  })

  it('makes one attempt under an always policy', async () => {
    const { adapter, engine, agent, input } = fixture({ mode: 'always' })
    adapter.failures.push(failure('SERVER'))
    await expect(engine.run(input, agent)).rejects.toMatchObject({ code: 'SERVER' })
    expect(adapter.calls).toBe(1)
  })

  it('rejects with the cancellation reason during a backoff wait', async () => {
    const { adapter, engine, agent, input } = fixture({ mode: 'normal', maxRetries: 1,
      backoff: { initialDelayMs: 60_000, maxDelayMs: 60_000 } })
    adapter.failures.push(failure('SERVER'))
    const controller = new AbortController()
    const reason = new Error('turn cancelled')
    const started = performance.now()
    const pending = engine.run(input, agent, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(adapter.calls).toBe(1)
  })

  it('does not retry a failure thrown by stream middleware', async () => {
    const { ctx, adapter, engine, agent, input } = fixture()
    let thrown = 0
    ctx.on('llm/stream', (_options, _next) => (async function * (): AsyncIterable<StreamChunk> {
      thrown += 1
      throw new LlmError('middleware gateway unavailable', 'SERVER')
    })())
    await expect(engine.run(input, agent)).rejects.toMatchObject({ code: 'SERVER' })
    expect(thrown).toBe(1)
    expect(adapter.calls).toBe(0)
  })

  it('reports the original failure when the route is withdrawn during the attempt', async () => {
    const { adapter, registration, engine, agent, input } = fixture()
    adapter.failures.push(failure('SERVER'))
    adapter.onCall = () => { registration() }
    await expect(engine.run(input, agent)).rejects.toMatchObject({ code: 'SERVER' })
    expect(adapter.calls).toBe(1)
  })

  it('records only the successful attempt in the compaction transaction', async () => {
    const { adapter, engine, agent, session } = fixture()
    adapter.failures.push(failure('SERVER'))
    const nodes = session.surface.nodes
    await engine.compactRegion(nodes[0]!, nodes[3]!, agent)
    const events = session.snapshotEvents()
    const summaries = events.filter(event => event.type === 'compaction/summary')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.data).toMatchObject({ rawOutput: [{ type: 'text', text: 'CHECKPOINT_ATTEMPT_2' }],
      usage: { inputTokens: 102, outputTokens: 7 } })
    expect(JSON.stringify(events)).not.toContain('FAILED_ATTEMPT')
    const end = events.findLast(event => event.type === 'compaction/end')
    expect(end?.data).not.toHaveProperty('error')
    expect(adapter.calls).toBe(2)
  })
})
