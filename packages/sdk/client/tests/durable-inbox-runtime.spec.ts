/** Durable claims through the ordinary built SDK profile and its actual enqueue receipt. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent'
import { DeepSeekHarness, validatedSessionEvent } from '../src/index.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const CLI = join(ROOT, 'apps/cli/lib/bin.js')
const CASE = fileURLToPath(new URL('./fixtures/durable-inbox-runtime/', import.meta.url))
const SESSION = 'sdk-durable-inbox-primary'
const TASK = 'Keep this original SDK input and reply once.'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hydrate(value: unknown, human: string, filtered: string): unknown {
  if (typeof value === 'string') return value.replaceAll('{{humanMessage}}', human).replaceAll('{{filteredMessage}}', filtered)
  if (Array.isArray(value)) return value.map(item => hydrate(item, human, filtered))
  return record(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrate(item, human, filtered)])) : value
}

it.skipIf(!existsSync(CLI))('retains the real SDK human ID through claim, filter and settlement exactly once', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-durable-inbox-'))
  try {
    const home = join(cwd, 'home'), scope = join(home, 'profiles/sdk/node_modules/@deepseek-ai')
    await mkdir(scope, { recursive: true })
    await symlink(join(ROOT, 'packages/test-support/llm-replay'), join(scope, 'dsh-llm-replay'), process.platform === 'win32' ? 'junction' : 'dir')
    const harness = new DeepSeekHarness({
      dshBin: CLI, profile: 'sdk', dshHome: home, cwd, processCwd: cwd,
      patches: [join(CASE, 'cordis.patch.yml')], provider: 'sdk-claim-replay', model: 'claim-model',
      env: { ...process.env, DEEPSEEK_API_KEY: '', DSH_TELEMETRY_DISABLED: '1', DSH_EXAMPLE_MODE: 'lib',
        DSH_SNAPSHOT: 'replay', DSH_SNAPSHOT_FILE: join(CASE, 'reply.json'), DSH_SNAPSHOT_OVERRIDE: join(CASE, 'reply.json') },
      initializeTimeoutMs: 30_000,
    })
    try {
      const requests = vi.spyOn(harness.client, 'request')
      const result = await harness.run(TASK, { sessionId: SESSION })
      const queryIndexes = requests.mock.calls.flatMap(([method], index) => method === 'session/query' ? [index] : [])
      expect(queryIndexes).toHaveLength(1)
      const queryResult = requests.mock.results[queryIndexes[0]!]!
      if (queryResult.type !== 'return') throw new Error('The real SDK query did not return')
      const receipt: unknown = await queryResult.value
      if (!record(receipt) || receipt.kind !== 'prompt' || typeof receipt.messageId !== 'string') throw new Error('Missing real prompt receipt')
      const humanId = receipt.messageId
      expect(result.sessionId).toBe(SESSION)
      const notifications = result.notifications.filter(notification => notification.method === 'session.event'
        && notification.params.sessionId === SESSION).map(notification => validatedSessionEvent(notification.params.event))
      expect(notifications).toEqual(result.events)
      const insertions = result.events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
      const original = insertions.filter(message => message.id === humanId)
      expect(original).toHaveLength(1)
      const filtered = insertions.find(message => message.id !== humanId)
      if (filtered === undefined) throw new Error('Missing runtime-filtered input')
      expect(filtered.id).not.toBe(humanId)
      const admitted = result.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data] : [])
      expect(admitted.map(message => message.id)).toEqual([humanId])
      const claims = result.events.filter(event => event.type.startsWith('agent/inbox/claim')).map(event => ({ type: event.type, data: event.data }))
      const header = result.events.find(event => event.type === 'request/header')
      const end = result.events.find(event => event.type === 'turn/end')
      if (header?.type !== 'request/header' || end?.type !== 'turn/end') throw new Error('Missing actual SDK request or completion')
      expect(result.finishReason, JSON.stringify(end.data)).toBe('completed')
      expect(result.finalResponse).toBe('SDK_DURABLE_CLAIM_OK')
      const proof: unknown = JSON.parse(await readFile(join(cwd, 'sdk-durable-inbox-proof.json'), 'utf8'))
      if (!record(proof) || !Array.isArray(proof.modelMessageIds)) throw new Error('Missing actual model input evidence')
      expect(proof.humanMessageId).toBe(humanId)
      expect(proof.filteredMessageId).toBe(filtered.id)
      const actual = { sessionId: result.sessionId, queryReceipt: receipt, humanEnqueueReceipts: original.length,
        originalHuman: original[0], claims, admittedUserMessages: admitted, modelRequest: header.data.header.config,
        finalResponse: result.finalResponse, finishReason: result.finishReason, turnEnd: end.data,
        proof: { sessionId: proof.sessionId, humanMessageId: proof.humanMessageId, filteredMessageId: proof.filteredMessageId,
          requests: proof.requests, humanWasModelInput: proof.modelMessageIds.includes(humanId),
          filteredWasModelInput: proof.modelMessageIds.includes(filtered.id) } }
      const expected: unknown = JSON.parse(await readFile(new URL('./expected/durable-inbox-runtime.json', import.meta.url), 'utf8'))
      expect(actual).toEqual(hydrate(expected, humanId, filtered.id))
    } finally { await harness.close() }
  } finally { await rm(cwd, { recursive: true, force: true }) }
}, 60_000)
