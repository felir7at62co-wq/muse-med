/** A live in-process child whose model abort overlaps the factory's projection teardown. */
import { appendFileSync, existsSync, watch } from 'node:fs'
import { dirname } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { installLlmReplay } from '@deepseek-ai/dsh-llm-replay'

export const name = 'factory-shutdown-fixture'
export const inject = ['agents', 'llm', 'subagents']

/** Install a keyless child and a deterministic late-abort producer, triggered after SDK initialization. */
export function apply(ctx, config) {
  const controller = new AbortController()
  const receipt = (phase, data = {}) => {
    appendFileSync(config.receiptFile, JSON.stringify({ phase, ...data }) + '\n')
  }
  let published = false
  let ready = false
  const modelReady = () => {
    if (ready || !published || !existsSync(config.readyFile)) return
    ready = true
    receipt('model-ready')
    process.stderr.write('SHUTDOWN_MODEL_READY\n')
  }
  const watcher = watch(dirname(config.readyFile), modelReady)
  ctx.effect(() => () => { watcher.close() })
  const replay = installLlmReplay(ctx, {
    file: config.replayFile,
    overrideFile: config.overrideFile,
    providers: [{ id: 'shutdown-replay', models: [{ id: 'shutdown' }] }],
  })
  ctx.effect(() => replay.dispose)
  ctx.on('llm/stream', (options, next) => (async function* () {
    try {
      yield* next()
    } finally {
      if (options.signal?.aborted) {
        receipt('model-aborted')
        process.stderr.write('SHUTDOWN_MODEL_ABORTED\n')
        // Every sibling effect has entered its synchronous teardown before
        // this barrier; the child result still awaits iterator quiescence.
        await setImmediate()
        controller.abort('late parent cancellation')
        receipt('late-abort-delivered')
        process.stderr.write('SHUTDOWN_LATE_ABORT_DELIVERED\n')
      }
    }
  })())
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.id !== 'shutdown-parent') return next()
    const run = await ctx.subagents.start('spawn', {
      label: 'shutdown-child',
      prompt: [{ type: 'text', text: 'Reply with exactly: child answer 42.' }],
      parent: agent,
      signal: controller.signal,
    })
    receipt('published', { pid: process.pid, parentId: agent.id, childId: run.id })
    published = true
    modelReady()
    const result = await run.result
    receipt('settled', { stopReason: result.stopReason })
    return { kind: 'reject' }
  })
}
