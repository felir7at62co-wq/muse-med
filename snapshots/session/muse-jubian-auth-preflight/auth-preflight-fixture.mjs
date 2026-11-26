/** Replay the real catalog tool against synthetic credential changes and a single read-only provider route. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requests } from './auth-transport-fixture.mjs'

export const name = 'auth-preflight-fixture'
export const inject = ['llm', 'jubianToken']

/** @param ctx - Shipped Headless profile services. */
export function apply(ctx) {
  let renewed = false
  ctx.on('llm/stream', async function* (options, next) {
    const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'auth-check-1')
    if (result?.isError && !renewed) {
      await ctx.jubianToken.set('offline-auth-renewed')
      renewed = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(results.length, 2)
    assert.equal(results[0].data.error?.code, 'AUTHENTICATION_REQUIRED')
    const checked = JSON.parse(results[1].data.message.content.find(block => block.type === 'text').text)
    assert.equal(checked.authentication.status, 'read_access_confirmed')
    assert.equal(checked.authentication.generation_submitted, false)
    assert.doesNotMatch(JSON.stringify(results.map(event => event.data.message.content)), /offline-auth-|private provider message|private project title/u)
    assert.deepEqual(requests, ['GET', 'GET'])
    const proof = { requests, initial: results[0].data.error.code, renewed: checked.authentication.status, submitted: false }
    await writeFile(join(agent.session.header.cwd, 'auth-proof.json'), JSON.stringify(proof, null, 2) + '\n')
  })
}
