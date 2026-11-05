import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'snapshot-dynamic-tool-prompt-updates'
export const inject = ['tools', 'systemPrompt']

/** Keep the prompt prefix while adding a tool and rebuilding its declaration series. */
export function apply(ctx: Context): void {
  let removeTool: (() => void) | undefined
  let guidance = ''
  ctx.systemPrompt.section({ name: 'snapshot:dynamic-tool-guidance', order: 400, text: () => guidance })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (!result.isError && exec.name === 'read') {
      guidance = 'Dynamic tool guidance: call snapshot_ping once, then reply with the single word DONE.'
      removeTool = ctx.tools.register(defineContentToolFixture({
        name: 'snapshot_ping', description: 'Return pong once.', parameters: {},
        async execute() { return [{ type: 'text', text: 'pong' }] },
      }))
    }
    if (!result.isError && exec.name === 'snapshot_ping') removeTool?.()
    return downstream
  })
  let requests = 0
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    return requests === 2 && decision.kind === 'enter'
      ? { ...decision, startsRequestSeries: true }
      : decision
  })
  let firstMessages: GenerateOptions['messages'] = []
  let secondMessages: GenerateOptions['messages'] = []
  ctx.on('llm/stream', (options, next) => {
    if (++requests === 1) firstMessages = options.messages
    else if (requests === 2) {
      assert.deepEqual(options.messages.slice(0, firstMessages.length), firstMessages)
      assert.equal(options.messages.filter(message => message.role === 'system').length, 2)
      assert.equal(options.tools?.some(tool => tool.name === 'snapshot_ping'), true)
      secondMessages = options.messages
    } else if (requests === 3) {
      assert.deepEqual(options.messages.slice(0, secondMessages.length), secondMessages)
      assert.equal(options.messages.filter(message => message.role === 'system').length, 2)
      assert.equal(options.tools?.some(tool => tool.name === 'snapshot_ping'), false)
    }
    return next()
  })
}
