/** Check that a binding recovery only creates the target identity file. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'bind-only-fixture'
export const inject = ['tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated headless profile. */
export function apply(ctx) {
  let count = 0
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'drama_project') return decision
    assert.equal(exec.arguments.action, 'bind_only')
    assert.equal(++count, 1)
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.equal(JSON.parse(await readFile(join(process.cwd(), 'target', 'project_config.json'), 'utf8')).jubian_script_id, 6750)
    assert.deepEqual(JSON.parse(await readFile(join(process.cwd(), 'target', 'project_config.json'), 'utf8')), { jubian_script_id: 6750 })
    await assert.rejects(readFile(join(process.cwd(), 'target', 'project-bible.md')), { code: 'ENOENT' })
    return decision
  })
  ctx.on('agent/turn-stopping', () => { assert.equal(count, 1) })
}
