/** Script only the external model; all calls run through the real Agent and Tools. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

export const name = 'delegation-scripted-llm'
export const inject = ['llm']
export const episodeText = (episode: number): string => `EP${episode}: verified fixture manuscript\n`
const todos = (completed: number) => ({ todos: Array.from({ length: 7 }, (_, i) => ({
  content: `Verify EP${i + 1} manuscript`,
  status: i < completed ? 'completed' : i === completed ? 'in_progress' : 'pending',
})) })

function call(step: number, name: string, args: object): StreamChunk[] {
  const id = ToolCallId(`delegation-${step}-${name}`)
  const argumentsText = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function text(value: string, partial = false): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: partial ? 'max-tokens' : 'stop' } },
  ]
}

/** Register a keyless adapter; no supplier adapter or account route is mounted. */
export function apply(ctx: Context): void {
  class ScriptedAdapter extends LlmAdapter {
    private readonly steps = new Map<string, number>()

    override async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: 'Offline delegation fixture', inputModalities: ['text' as const] }
    }

    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const session = String(options.sessionId)
      const step = this.steps.get(session) ?? 0
      this.steps.set(session, step + 1)
      let chunks: StreamChunk[]
      if (session === 'delegation-main') {
        if (step === 0) {
          const prompt = JSON.stringify(options.messages)
          if (!prompt.includes('You are the Main Bot (Chief of Staff)')
            || !prompt.includes('its brief is background, not an assigned task')) {
            throw new Error('Real Main Bot identity and delegation guidance did not reach the model')
          }
          chunks = call(step, 'todo_write', todos(0))
        }
        else if (step === 1) chunks = call(step, 'message_bot', {
          to: 'Writer', request_id: 'ep1-7',
          message: 'Write EP1–7 as ep1.md through ep7.md in the working folder. Report actual completed and unfinished ranges; return here.',
        })
        else if (step === 2 || step === 8) chunks = text('Waiting for the assigned range; no completion claim.')
        else if (step >= 3 && step <= 5) {
          if (!JSON.stringify(options.messages).includes('assigned work is not confirmed complete')) {
            throw new Error('Main did not receive the actual incomplete-turn notice')
          }
          chunks = call(step, 'read', { file_path: `ep${step - 2}.md` })
        } else if (step === 6) chunks = call(step, 'todo_write', todos(3))
        else if (step === 7) chunks = call(step, 'message_bot', {
          to: 'Writer', request_id: 'ep4-7',
          message: 'EP1–3 were read back and verified. Continue only the unfinished EP4–7; write ep4.md through ep7.md. Do not rewrite EP1–3. Return results here.',
        })
        else if (step >= 9 && step <= 12) chunks = call(step, 'read', { file_path: `ep${step - 5}.md` })
        else if (step === 13) chunks = call(step, 'todo_write', todos(7))
        else if (step === 14) chunks = text('Verified all seven saved manuscripts after reading every file; EP1–7 complete.')
        else throw new Error(`Unexpected Main model step ${step}`)
      } else if (session === 'delegation-writer') {
        if (step === 3) chunks = text('Partial: EP1–3 saved; EP4–7 unfinished.', true)
        else if (step === 8) chunks = text('EP4–7 saved; requested remaining range returned.')
        else {
          const episode = step < 3 ? step + 1 : step
          if (episode < 1 || episode > 7) throw new Error(`Unexpected Writer model step ${step}`)
          chunks = call(step, 'write', { file_path: `ep${episode}.md`, content: episodeText(episode) })
        }
      } else throw new Error(`Unexpected model Session ${session}`)
      for (const chunk of chunks) yield chunk
    }
  }
  ctx.llm.registerAdapter(['delegation-fixture'], new ScriptedAdapter())
}
