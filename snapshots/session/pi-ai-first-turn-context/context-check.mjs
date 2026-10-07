/** Check pi-ai serialization against the first request assembled by the shipped profile. */
import { toPiContext } from '../../../packages/llm/llm-pi-ai/src/context.ts'

export const name = 'pi-ai-first-turn-context-check'

export function apply(ctx) {
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type !== 'start' || frame.turn !== 1 || frame.step !== 1) return
    const history = agent.session.deriveMessages()
    const input = history.filter(message => message.role === 'user')
    if (input.length < 2 || input[0].source.kind !== 'user') {
      throw new Error('First-turn snapshot needs a task followed by injected context')
    }
    const converted = toPiContext({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: history })
    const users = converted.messages.filter(message => message.role === 'user')
    const expected = input.map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join('')).join('\n\n')
    if (users.length !== 1 || users[0].content !== expected) {
      throw new Error('First-turn pi-ai request must retain the task and injected context in one user message')
    }
  })
}
