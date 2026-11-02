/** Assert that a later root failure retains a session's last complete skill catalog. */
import assert from 'node:assert/strict'
import { symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

export const name = 'snapshot-skill-root-isolation'
export const inject = ['fs', 'skills']

/** Create a failing root only after the first successful skill load, then inspect the next request. */
export function apply(ctx: Context): void {
  const goodRoot = join(process.cwd(), '.dsh/skills')
  const badRoot = join(process.cwd(), 'broken-skills')
  let created = false
  let requests = 0
  let firstCatalog: GenerateOptions['messages'] = []

  ctx.effect(() => async () => {
    if (created) await unlink(badRoot)
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (exec.name !== 'skill') return downstream
    assert.equal(result.isError, false, 'skill tool completed successfully before root failure')
    assert.equal(requests, 1)
    await symlink('broken-skills', badRoot)
    created = true
    const target = await ctx.fs.resolve(join(goodRoot, 'editing-cordis-compositions/SKILL.md'))
    const info = await ctx.fs.stat(target)
    assert.ok(info)
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, { name: 'write' })
    return downstream
  })
  ctx.on('llm/stream', (options, next) => (async function* () {
    requests += 1
    const lookup = { cwd: process.cwd(), signal: options.signal }
    const snapshot = await ctx.skills.snapshot(lookup)
    assert.equal(snapshot.complete, requests === 1, `root isolation request ${requests} completeness`)
    assert.deepEqual(snapshot.skills.map(skill => skill.name), ['editing-cordis-compositions'])
    const skill = await ctx.skills.get('editing-cordis-compositions', lookup)
    assert.ok(skill?.content.includes('Extend the Host'))
    const catalogs = options.messages.filter(message => message.source?.kind === 'skill-catalog')
    if (requests === 1) {
      assert.equal(created, false)
      assert.equal(catalogs.length, 1)
      firstCatalog = catalogs
    } else {
      assert.equal(requests, 2)
      assert.equal(created, true)
      assert.deepEqual(catalogs, firstCatalog)
    }
    yield* next()
  })())
}
