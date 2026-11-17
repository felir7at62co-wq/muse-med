#!/usr/bin/env node
/**
 * Real app/Loader test of the shipped Desktop prompt-usage-guard row: only model
 * responses are synthetic, emulating the Yunying lane that drops tool definitions.
 */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage, expandAssistantStream, LlmAdapter, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, NormalRetryPolicyConfig, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

const [configPath, scenario] = process.argv.slice(2)
if (!configPath) throw new Error('expected real Loader config path')
if (scenario !== 'recover' && scenario !== 'exhausted') throw new Error('expected recover or exhausted')
const uninstall = installFailLoud('prompt-usage-loader-test')
let ctx: Context | undefined

const PROVIDER = 'muse-cloud-yunying'
const MODEL = 'gemini-3.1-pro'
const CODE = 'PROMPT_USAGE_SHORTFALL'
const DROPPED = 'I am not running inside the client, so I will write the content directly.'

/** Read one member of parsed overlay configuration. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined
}

function reply(text: string, inputTokens: number): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens, outputTokens: 20 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Answers like the dropping lane until `healthyFrom`, then with a full prompt. */
class SyntheticRelayAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly policy: ResolvedRetryPolicy, private readonly healthyFrom: number) { super() }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.policy
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield* this.requests.length >= this.healthyFrom ? reply('Recovered answer.', 1_000_000) : reply(DROPPED, 40)
  }
}

try {
  const desktop = loadOverlayPatches('prompt-usage-loader-test', fileURLToPath(new URL(
    '../../../../../apps/desktop-host/config/desktop.cordis.patch.yml', import.meta.url,
  )))
  const rows = desktop.flatMap(patch => patch.insert ?? [])
  const guardRows = rows.filter(row => row.id === 'prompt-usage-guard')
  assert.equal(guardRows.length, 1)
  assert.equal(guardRows[0]?.name, '@deepseek-ai/dsh-prompt-usage')
  assert.deepEqual(guardRows[0]?.config, { routes: [{ provider: PROVIDER, model: MODEL, minToolSchemaRatio: 1, minEstimateRatio: 0.5 }] })
  // The shipped policy; only the backoff is shortened below.
  const shippedPolicy: NormalRetryPolicyConfig = {
    mode: 'normal', maxRetries: 8,
    retryableCodes: ['EMPTY_RESPONSE', 'INVALID_TOOL_ARGUMENTS', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', CODE],
    backoff: { initialDelayMs: 2000, maxDelayMs: 60000 },
  }
  const accountConfig: unknown = rows.find(row => row.id === 'muse-account')?.config
  assert.deepEqual(field(accountConfig, 'modelRetryPolicy'), shippedPolicy)
  const goalConfig: unknown = desktop.find(patch => patch.id === 'goal-round-driver')?.config
  assert.deepEqual(field(goalConfig, 'transientErrorResume'), { maxAttempts: 3, delayMs: 120000, codes: ['SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED', CODE] })

  ctx = await boot('prompt-usage-loader-test', configPath, [{ insert: guardRows }])
  const loaded = ctx
  // Only the backoff is shortened; codes, mode and retry count are the shipped values.
  const policy = resolveRetryPolicy({ ...shippedPolicy, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'shipped muse-account modelRetryPolicy')
  const adapter = new SyntheticRelayAdapter(policy, scenario === 'recover' ? 2 : Number.POSITIVE_INFINITY)
  loaded.llm.registerAdapter([PROVIDER], adapter)
  loaded.tools.register(defineTool({
    name: 'read_episode',
    description: `Read one episode transcript from the project. ${'Keep speaker labels and timing. '.repeat(120)}`,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'episode',
  }))
  const agent = await loaded.agentLoop.create(SessionId('prompt-usage-loader'), { provider: PROVIDER, model: MODEL })
  const settled = Promise.withResolvers<null>()
  loaded.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'turn/end') settled.resolve(null)
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Transcribe the next episode.' }], source: { kind: 'user' } }))
  await settled.promise
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const attempts = events.filter(event => event.type === 'assistant/attempt')
  for (const attempt of attempts) {
    const finish = expandAssistantStream(attempt.data.stream).map(record => record.chunk).at(-1)
    assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error' && finish.reason.failure.code === CODE)
  }
  const retries = events.filter(event => event.type === 'llm/retry')
  const messages = events.filter(event => event.type === 'assistant/message')
  const turnEnd = events.findLast(event => event.type === 'turn/end')
  const laterRequests = adapter.requests.slice(1).map(request => JSON.stringify(request.messages))
  await writeFile(join(process.cwd(), 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n', { flag: 'wx' })
  await loaded.fiber.dispose()
  ctx = undefined
  const result = {
    passed: true, scenario,
    requests: adapter.requests.length,
    rejected_attempts: attempts.length,
    retry_events: retries.length,
    retry_codes: [...new Set(retries.map(event => event.data.failure.code))],
    committed_messages: messages.length,
    final_text_recovered: JSON.stringify(messages.at(-1)?.data.message.content ?? []).includes('Recovered answer.'),
    rejected_text_in_later_requests: laterRequests.some(text => text.includes(DROPPED)),
    turn_end: turnEnd?.data.reason.kind === 'error' ? turnEnd.data.reason.error.code : turnEnd?.data.reason.kind,
    actual_desktop_rows_loaded: true,
    plugin_disposal_completed: true,
  }
  await writeFile(join(process.cwd(), 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await ctx?.fiber.dispose()
  uninstall()
}
