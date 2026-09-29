/** Scenario-local human answer and durable Settings assertions. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'

export const name = 'draft-root-fixture'
export const inject = ['tools', 'settings', 'userQuestions']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario composition. */
export function apply(ctx) {
  let questions = 0
  ctx.on('user-questions/request', async ({ questions: items }) => {
    assert.equal(++questions, 1, 'a valid saved root must not be requested again')
    assert.equal(items[0].id, 'draft-root')
    return { answers: [{ id: 'draft-root', selected: [], custom: process.cwd() }] }
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.callId === 'get-saved') {
      assert.equal(questions, 1)
      const current = ctx.settings.describe().find(row => row.ns === 'drama-settings')
      assert.equal(current.value.jianyingDraftDir, normalize(process.cwd()))
      const persisted = await readFile(join(process.cwd(), '.dsh/profiles/headless/cordis.patch.yml'), 'utf8')
      assert.ok(persisted.includes('jianyingDraftDir:'), 'draft setting must be persisted')
      assert.ok(persisted.includes(normalize(process.cwd())), 'persisted root must match the answer')
    }
    return next()
  })
}
