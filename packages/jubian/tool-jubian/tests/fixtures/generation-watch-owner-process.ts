/** Independent process for notification ownership and stale-lease tests. */
import { GenerationWatchStore, type GenerationWatchRun } from '../../src/generation-watch-store.ts'
import { GenerationWatchRuntime } from '../../src/generation-watch.ts'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { appendFile } from 'node:fs/promises'
import { bodyHash, writeUnderLedger } from '../../src/write.ts'

const [root, mode, payload] = process.argv.slice(2)
if (root === undefined || mode === undefined || payload === undefined) throw new Error('Missing test process arguments')
const store = new GenerationWatchStore(root)
process.send?.({ kind: 'ready' })
process.once('message', () => { void runWorker(root, mode, payload) })
async function runWorker(root: string, mode: string, payload: string): Promise<void> {
  try {
    if (mode.startsWith('ledger-')) {
      const run = JSON.parse(payload) as GenerationWatchRun
      const key = run.packs[0]?.key
      if (key === undefined) throw new Error('Missing original key')
      const ledger = new JubianLedger({ root: join(root, 'ledger'), defaultLimitCents: () => 10000 })
      const intent = { idempotencyKey: key, method: 'storyboard_native_submit' as const,
        requestSha256: bodyHash({ original: key }), scriptId: 42, quotedAmount: '1.00', quoteUnit: 'CNY' }
      if (mode === 'ledger-reserved') {
        await ledger.begin(intent)
        process.send?.({ kind: 'reserved' })
        await new Promise<void>(() => {})
        return
      }
      if (mode === 'ledger-batch') {
        await ledger.beginManyChecked([key], async () => [intent])
        await appendFile(join(root, 'sent.ndjson'), `${key}\n`)
        await ledger.settle(key, { httpStatus: 200, applicationCode: 200, responseSha256: null, outcome: 'accepted' })
        process.send?.({ kind: 'sent' }, () => { process.disconnect?.() })
        return
      }
      const result = await writeUnderLedger(ledger, key, 'storyboard_native_submit', () => ({ original: key }), async () => {
        await appendFile(join(root, 'sent.ndjson'), `${key}\n`)
        return { transport: { http_status: 200, application_code: 200 }, response_sha256: null, data: {} }
      }, () => ({ amount: '1.00', unit: 'CNY', scriptId: 42 }))
      process.send?.({ kind: result.replayed ? 'replayed' : 'sent' }, () => { process.disconnect?.() })
      return
    }
    if (mode === 'claim') {
      await store.claimOwnership(JSON.parse(payload) as GenerationWatchRun)
      process.send?.({ kind: 'claimed' }, () => { process.disconnect?.() })
      return
    }
    if (mode === 'enroll') {
      const run = JSON.parse(payload) as GenerationWatchRun
      const runtime = new GenerationWatchRuntime({ store, ledger: new JubianLedger({ root: join(root, 'ledger') }),
        client: new JubianClient({ credential: async () => 'fixture', fetch: async () => { throw new Error('unexpected network') } }),
        deliver: async () => 'pending', withoutInitiator: async (operation) =>{  await operation() },
        warn: () => {}, watchPollIntervalMs: 100, watchTimeoutMs: 5000 })
      const enrollment = await runtime.enroll(SessionId(run.sessionId), run.packs)
      await runtime.close()
      process.send?.({ kind: enrollment.initial ? 'initial' : 'replay' }, () => { process.disconnect?.() })
      return
    }
    if (mode === 'interrupt-create') {
      Object.defineProperty(store, 'createCheckpoint', { value: async () => {
        process.send?.({ kind: 'before-checkpoint' })
        return await new Promise<GenerationWatchRun>(() => {})
      } })
      await store.claimAndCreate(JSON.parse(payload) as GenerationWatchRun)
      throw new Error('The interrupted checkpoint unexpectedly completed')
    }
    if (mode === 'lease') {
      await store.withRecoveryLease(payload, new AbortController().signal, 5000, async () => {
        process.send?.({ kind: 'locked' })
        await new Promise<void>(() => {})
      })
      return
    }
    throw new Error('Unknown test process mode')
  } catch (error) {
    process.send?.({ kind: 'rejected', message: error instanceof Error ? error.message : String(error) },
      () => { process.disconnect?.() })
  }
}
