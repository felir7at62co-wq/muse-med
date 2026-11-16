/** Logged replacement of a frame message before later successful model replies. */
import assert from 'node:assert/strict'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'snapshot-compacted-video-frame'
export const inject = ['agents', 'tools']

/** Install the deterministic compaction sequence and its read-only checkpoint probe. */
export function apply(ctx) {
  let seeded = false
  let retired
  ctx.on('agent/request', ({ agent, turn, step }, next) => {
    if (!seeded) {
      seeded = true
      agent.session.append('system/message', { turn, step, message: createSystemMessage('') }, { surfaceOp: 'append' })
      retired = agent.session.append('user/message', createUserMessage({
        source: { kind: 'user' }, content: [
          { type: 'text', text: 'VIDEO_FRAME historical-review/F00001 earlier frame' },
          { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
        ],
      }), { surfaceOp: 'append' }).seq
      agent.session.append('user/message', createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: 'Earlier frame observations were preserved in this summary.' }],
      }), { surfaceOp: { op: 'replace', startSeq: retired, endSeq: retired }, sourceEventSeqs: [retired] })
    }
    return next()
  }, { prepend: true })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'checkpoint_probe', description: 'Confirm the saved conversation summary is available.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (_args, exec) => {
      assert.ok(exec.agent)
      assert.ok(!exec.agent.session.surface.nodes.includes(retired))
      return 'SUMMARY AVAILABLE'
    },
  })))
  ctx.on('agent/turn-stopping', ({ agent }) => {
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'image/offload').length, 0)
    assert.ok(!agent.session.surface.nodes.includes(retired))
  })
}
