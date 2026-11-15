/** Native question answers test acceptance state, not acoustic quality or a generated video. */
import assert from 'node:assert/strict'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const { createContentReviewVerifier } = await importSnapshotModule(
  new URL('../../../packages/drama/tool-episode-render/src/index.ts', import.meta.url),
  new URL('../../../packages/drama/tool-episode-render/lib/index.js', import.meta.url),
)

export const name = 'content-listening-fixture'
export const inject = ['tools', 'userQuestions', 'sessionProjections']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Actual shipped-profile composition. */
export async function apply(ctx) {
  const factory = await createContentReviewVerifier(ctx)
  let count = 0
  let question
  ctx.on('user-questions/request', async ({ questions }) => {
    assert.equal(questions.length, 1)
    question = questions[0]
    assert.equal(question.id, `content-listening-${'a'.repeat(64)}`)
    assert.equal(question.options.length, 2)
    return { answers: [{ id: question.id, selected: [question.options[count++].label] }] }
  })
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (exec.name !== 'fs_read') return await next()
    assert.ok(exec.agent, 'checking uses the actual initiating Session')
    const verify = factory(exec.agent.session, exec.signal)
    const binding = { kind: 'listening', sessionId: exec.agent.session.id,
      callId: count === 1 ? 'listen-accepted' : 'listen-rejected', questionId: question.id, question: question.question }
    if (count === 1) await verify(binding)
    else {
      assert.equal(count, 2)
      await assert.rejects(verify(binding), /没有当前成片的真实已完成试听回答/)
      await assert.rejects(verify({ ...binding, callId: 'listen-accepted' }), /没有当前成片的真实已完成试听回答/)
    }
    return await next()
  })
}
